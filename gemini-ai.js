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
    maxTokens = 2048,
    temperature = 0.2,
    timeoutMs = 15000,
    retries = 1,
  } = opts;

  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

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
              const parts = parsed.candidates?.[0]?.content?.parts || [];
              const textObj = parts.find(p => p.text && typeof p.text === 'string') || parts[0];
              const text = textObj?.text?.trim();
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
      maxTokens: 1000,
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
      maxTokens: 1000,
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
 * AI-Powered Humanized ATS Resume Tailoring.
 *
 * Rewrites the resume Summary & Skills to match the JD with zero AI clichés.
 * Strictly uses active verbs, concrete metrics (9.27 CGPA, ESP32, FreeRTOS, etc.),
 * and natural human engineer syntax.
 *
 * @param {object} params - { title, jdText, currentSummary, category, cv, apiKey }
 * @returns {Promise<{ summary: string, highlightedSkills: string[], projectFocus: string }|null>}
 */
async function tailorFullResume({ title = '', jdText = '', currentSummary = '', category = 'embedded', cv = {}, apiKey = '' }) {
  if (!apiKey) return null;

  const cvContext = formatCVContext(cv);
  const truncatedJD = jdText.length > 2000 ? jdText.substring(0, 2000) + '...' : jdText;

  const prompt = `You are an expert resume writer tailoring a resume for an Indian electronics and software engineering student.
Your goal is to tailor the candidate's Summary and Skills to achieve a 95%+ ATS keyword match for the target job while sounding 100% human, authentic, and technically grounded.

CANDIDATE FACTUAL BACKGROUND (DO NOT INVENT FAKE DATA):
Name: Aditya Mittha | Location: Solapur / Pune, India
Education: B.Tech in Electronics & Telecommunication, Walchand Institute Of Technology (CGPA: 9.27, Graduating 2027)
Internship: Embedded Systems Intern at Codec Technologies India (UART, I2C, Embedded C on MCUs)
Key Projects:
- LabPulse: Python background telemetry agent, AWS Serverless (Lambda, DynamoDB, API Gateway), Docker CI/CD
- AQUANOVA: ESP32 smart water pressure monitor, MQTT QoS 1 telemetry, ML anomaly detection
- SORTIFY: Raspberry Pi automated sorting system, Computer Vision, IoT dashboard
Core Skills: ${cv.skills || 'Embedded C, Python, FreeRTOS, ESP32, ARM Cortex-M, UART, I2C, SPI, CAN, MQTT, AWS, Docker, Linux, Git'}

TARGET JOB TITLE: ${title}
TARGET JOB DESCRIPTION:
${truncatedJD}

STRICT WRITING RULES TO AVOID AI FOOTPRINTS:
1. NEVER use AI buzzwords or cliché corporate filler:
   BANNED WORDS: "spearheaded", "testament", "delve", "tapestry", "foster", "synergy", "cutting-edge", "multifaceted", "holistic", "dynamic landscape", "passionate", "thrilled", "esteemed", "proven track record", "demonstrated aptitude", "harnessing", "unwavering".
2. Use active, direct engineer phrasing: "Built", "Engineered", "Implemented", "Configured", "Debugged", "Integrated", "Developed".
3. Summary must be strictly 2 to 3 sentences long. Mention 9.27 CGPA, Walchand, and exact technical tools required by the JD.
4. Highlighted skills must only include technologies the candidate actually knows that match the JD.

Respond ONLY with valid JSON (no markdown, no code fences):
{
  "summary": "<2-3 sentence punchy humanized summary tailored to the JD>",
  "highlightedSkills": ["skill1", "skill2", "skill3", "skill4", "skill5", "skill6"],
  "projectFocus": "<LabPulse|AQUANOVA|Codec Technologies|SORTIFY>"
}`;

  try {
    const raw = await callGemini(prompt, apiKey, {
      maxTokens: 2048,
      temperature: 0.2,
    });
    if (!raw) return null;

    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    const result = JSON.parse(cleaned);

    if (result && result.summary && result.summary.length > 40) {
      return {
        summary: result.summary.trim(),
        highlightedSkills: Array.isArray(result.highlightedSkills) ? result.highlightedSkills : [],
        projectFocus: result.projectFocus || 'Codec Technologies',
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Legacy wrapper for summary tailoring
 */
async function tailorResumeSummary(jdText, currentSummary, cv, apiKey) {
  const full = await tailorFullResume({ jdText, currentSummary, cv, apiKey });
  return full ? full.summary : null;
}

module.exports = {
  callGemini,
  analyzeJobWithAI,
  answerScreeningQuestion,
  tailorResumeSummary,
  tailorFullResume,
  formatCVContext,
};

