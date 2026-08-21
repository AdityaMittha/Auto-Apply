/**
 * Gemini AI Module — Centralized Gemini 2.0 Flash API integration for:
 *   1. AI-powered job analysis (semantic match scoring)
 *   2. Smart screening question answering
 *   3. Resume summary tailoring per JD
 *
 * Uses the free-tier Gemini API (1,500 req/day).
 * Falls back gracefully when API is unavailable.
 */
const https = require('https');

/**
 * Core Gemini API caller with retry logic and timeout.
 * @param {string} prompt - The full prompt to send
 * @param {string} apiKey - Gemini API key
 * @param {object} opts - { maxTokens, temperature, timeoutMs }
 * @returns {Promise<string|null>}
 */
function callGemini(prompt, apiKey, opts = {}) {
  const {
    maxTokens = 300,
    temperature = 0.2,
    timeoutMs = 10000,
    retries = 1,
  } = opts;

  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature,
    },
  });

  function attempt() {
    return new Promise((resolve) => {
      const req = https.request(
        {
          hostname: 'generativelanguage.googleapis.com',
          path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (d) => (data += d));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              const text =
                parsed.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
              resolve(text || null);
            } catch {
              resolve(null);
            }
          });
        }
      );

      req.on('error', () => resolve(null));
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        resolve(null);
      });
      req.write(body);
      req.end();
    });
  }

  // Retry wrapper
  return attempt().then((result) => {
    if (result !== null || retries <= 0) return result;
    return attempt(); // single retry
  });
}

/**
 * Formats the CV object into a concise text block for AI context.
 */
function formatCVContext(cv) {
  const parts = [
    `Name: ${cv.name}`,
    `Education: ${cv.education}`,
    `Current Role: ${cv.currentRole}`,
    `Experience: ${cv.yearsOfExperience}`,
    `Skills: ${cv.skills}`,
    `Location: ${cv.location}`,
    `Notice Period: ${cv.noticePeriod}`,
    `Current CTC: ${cv.currentCTC} LPA`,
    `Expected CTC: ${cv.expectedCTC} LPA`,
  ];
  if (cv.highlights && cv.highlights.length > 0) {
    parts.push(`Key Achievements: ${cv.highlights.join('; ')}`);
  }
  return parts.filter(Boolean).join('\n');
}

/**
 * AI-Powered Job Analysis — Sends JD + CV to Gemini for semantic match scoring.
 *
 * Returns: { matchScore, category, matchedSkills[], missingSkills[], reasoning }
 *
 * @param {string} title - Job title
 * @param {string} jdText - Full job description text
 * @param {object} cv - CV object from config.js
 * @param {string} apiKey - Gemini API key
 * @returns {Promise<object|null>} Analysis result or null on failure
 */
async function analyzeJobWithAI(title, jdText, cv, apiKey) {
  if (!apiKey) return null;

  const cvContext = formatCVContext(cv);
  // Truncate JD to ~2000 chars to stay within token budget
  const truncatedJD = jdText.length > 2000 ? jdText.substring(0, 2000) + '...' : jdText;

  const prompt = `You are a job-matching AI. Analyze how well this candidate fits the job.

CANDIDATE PROFILE:
${cvContext}

JOB TITLE: ${title}

JOB DESCRIPTION:
${truncatedJD}

Respond ONLY in this exact JSON format (no markdown, no code fences):
{
  "matchScore": <number 0-100>,
  "category": "<embedded|python_devops|general>",
  "matchedSkills": ["skill1", "skill2"],
  "missingSkills": ["skill1", "skill2"],
  "reasoning": "<1 sentence explaining the score>"
}

Scoring guidelines:
- 80-100: Strong match — most required skills present, relevant project experience
- 60-79: Good match — many skills overlap, some gaps
- 40-59: Partial match — some relevant skills but significant gaps
- 0-39: Poor match — very few relevant skills
- Category "embedded" if job involves firmware/microcontrollers/hardware/RTOS/IoT
- Category "python_devops" if job involves Python/cloud/DevOps/backend/automation
- Category "general" if neither fits clearly`;

  try {
    const raw = await callGemini(prompt, apiKey, {
      maxTokens: 250,
      temperature: 0.1,
    });
    if (!raw) return null;

    // Strip any markdown code fences if present
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    const result = JSON.parse(cleaned);

    // Validate expected fields
    if (typeof result.matchScore !== 'number') return null;
    result.matchScore = Math.max(0, Math.min(100, Math.round(result.matchScore)));
    result.matchedSkills = result.matchedSkills || [];
    result.missingSkills = result.missingSkills || [];
    result.category = result.category || 'general';
    result.reasoning = result.reasoning || '';

    return result;
  } catch {
    return null;
  }
}

/**
 * AI-Powered Screening Question Answerer.
 *
 * Given a screening question (with optional MCQ options) and the candidate's CV,
 * returns a natural, professional answer.
 *
 * @param {string} question - The screening question text
 * @param {string[]} options - MCQ options (empty array for free-text)
 * @param {object} cv - CV object from config.js
 * @param {string} apiKey - Gemini API key
 * @returns {Promise<string|null>} Answer string or null on failure
 */
async function answerScreeningQuestion(question, options, cv, apiKey) {
  if (!apiKey) return null;

  const cvContext = formatCVContext(cv);
  const optionsBlock =
    options.length > 0
      ? `\nAVAILABLE OPTIONS:\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}\n\nYou MUST pick one of the above options exactly as written. Return ONLY the option text.`
      : `\nThis is a free-text question. Answer concisely in 1-2 sentences. Be professional and authentic.`;

  const prompt = `You are ${cv.name}, answering a job application screening question. Use your actual profile data below.

YOUR PROFILE:
${cvContext}

SCREENING QUESTION: "${question}"
${optionsBlock}

Answer directly — no explanations, no quotes around the answer, no preamble.`;

  try {
    const raw = await callGemini(prompt, apiKey, {
      maxTokens: 120,
      temperature: 0.2,
    });
    if (!raw) return null;

    // For MCQ: find the closest matching option
    if (options.length > 0) {
      const cleaned = raw.trim().replace(/^["']|["']$/g, '');
      // Exact match first
      const exact = options.find(
        (o) => o.toLowerCase() === cleaned.toLowerCase()
      );
      if (exact) return exact;
      // Partial/contains match
      const partial = options.find(
        (o) =>
          cleaned.toLowerCase().includes(o.toLowerCase()) ||
          o.toLowerCase().includes(cleaned.toLowerCase())
      );
      if (partial) return partial;
      // Return raw if no match (caller can decide)
      return cleaned;
    }

    return raw.trim();
  } catch {
    return null;
  }
}

/**
 * AI-Powered Resume Summary Tailoring.
 *
 * Rewrites the resume Summary section to emphasize skills/experience
 * relevant to the specific JD. Returns plain text.
 *
 * @param {string} jdText - Job description text
 * @param {string} currentSummary - Current resume summary
 * @param {object} cv - CV object from config.js
 * @param {string} apiKey - Gemini API key
 * @returns {Promise<string|null>} Tailored summary or null on failure
 */
async function tailorResumeSummary(jdText, currentSummary, cv, apiKey) {
  if (!apiKey) return null;

  const truncatedJD = jdText.length > 1500 ? jdText.substring(0, 1500) + '...' : jdText;

  const prompt = `Rewrite this resume summary to better match the job description below. Keep it factual — only mention skills and experience the candidate actually has. Keep it 2-3 sentences, professional, and ATS-friendly.

CURRENT SUMMARY:
${currentSummary}

CANDIDATE SKILLS: ${cv.skills}
CANDIDATE EXPERIENCE: ${cv.yearsOfExperience}
CANDIDATE EDUCATION: ${cv.education}

JOB DESCRIPTION:
${truncatedJD}

Return ONLY the rewritten summary text. No quotes, no labels, no preamble.`;

  try {
    const raw = await callGemini(prompt, apiKey, {
      maxTokens: 200,
      temperature: 0.3,
    });
    return raw ? raw.trim() : null;
  } catch {
    return null;
  }
}

module.exports = {
  callGemini,
  analyzeJobWithAI,
  answerScreeningQuestion,
  tailorResumeSummary,
  formatCVContext,
};
