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
    model = process.env.GEMINI_MODEL || 'gemini-2.0-flash',
  } = opts;

  if (!apiKey || apiKey.trim().length < 10) {
    return Promise.resolve(null);
  }

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature,
    },
  });

  function makeRequest(targetModel) {
    return new Promise((resolve) => {
      const req = https.request(
        {
          hostname: 'generativelanguage.googleapis.com',
          path: `/v1beta/models/${targetModel}:generateContent?key=${apiKey}`,
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
              if (parsed.error) {
                // If model not found or quota error, resolve null to allow fallback
                resolve(null);
                return;
              }
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

  // Attempt with primary model, fallback to gemini-1.5-flash if needed
  return makeRequest(model).then((res) => {
    if (res !== null) return res;
    if (model !== 'gemini-1.5-flash') {
      return makeRequest('gemini-1.5-flash');
    }
    return null;
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

function extractJson(text) {
  if (!text) return null;
  try {
    const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    return JSON.parse(cleaned);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {}
    }
  }
  return null;
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
  const cvContext = formatCVContext(cv);
  // Truncate JD to ~2500 chars to capture all technical requirements
  const truncatedJD = jdText.length > 2500 ? jdText.substring(0, 2500) + '...' : jdText;

  if (apiKey) {
    const prompt = `You are an expert technical recruiter and ATS evaluation engine. Analyze how well this candidate fits the target Job Description (JD).

CANDIDATE PROFILE:
${cvContext}

JOB TITLE: ${title}

JOB DESCRIPTION:
${truncatedJD}

Respond ONLY in this exact JSON format (no markdown, no code fences):
{
  "matchScore": <number 0-100>,
  "category": "<embedded_software|embedded|python_devops|data_analytics|general>",
  "matchedSkills": ["skill1", "skill2", "skill3"],
  "missingSkills": ["skill1", "skill2"],
  "reasoning": "<1-2 sentences explaining why the candidate matches and key strengths>",
  "interviewTips": ["<Tip 1: Technical concept/protocol to brush up on for this JD>", "<Tip 2: Specific question the interviewer is likely to ask>"],
  "highlightedSkills": ["<Top 6 skills ordered by relevance to this JD>"],
  "tailoredSummary": "<2-3 sentence punchy humanized technical summary tailored directly to this JD without AI buzzwords>"
}

Scoring guidelines:
- 85-100: Strong match — core required skills present (e.g. Embedded C/FreeRTOS/ESP32, Python/AWS/Docker, or SQL/Pandas/Analytics), relevant project experience
- 65-84: Good match — strong overlap, candidate can immediately contribute with minor ramp-up
- 45-64: Partial match — foundational skills overlap with some specific framework/domain gaps
- 0-44: Poor match — unrelated domain
- Category "embedded_software" if job specifically targets Embedded Software Engineer, Firmware Developer, Device Driver, HAL/BSP, Embedded C/C++, FreeRTOS
- Category "embedded" if job involves general hardware/electronics/microcontrollers/IoT
- Category "data_analytics" if job involves Data Analyst/Analytics/SQL/Pandas/EDA/Business Intelligence/Tableau/Power BI
- Category "python_devops" if job involves Python/cloud/DevOps/backend/automation/AWS/Docker
- Category "general" if neither fits clearly`;

    try {
      const raw = await callGemini(prompt, apiKey, {
        maxTokens: 1500,
        temperature: 0.15,
      });
      if (raw) {
        const result = extractJson(raw);
        if (result && typeof result.matchScore === 'number') {
          result.matchScore = Math.max(0, Math.min(100, Math.round(result.matchScore)));
          result.matchedSkills = Array.isArray(result.matchedSkills) ? result.matchedSkills : [];
          result.missingSkills = Array.isArray(result.missingSkills) ? result.missingSkills : [];
          result.interviewTips = Array.isArray(result.interviewTips) ? result.interviewTips : [];
          result.highlightedSkills = Array.isArray(result.highlightedSkills) ? result.highlightedSkills : [];
          result.category = result.category || 'general';
          result.reasoning = result.reasoning || '';
          return result;
        }
      }
    } catch {}
  }

  // High-Quality Local Deterministic Fallback if API key missing or rate-limited
  const jdLower = (truncatedJD + ' ' + title).toLowerCase();
  const isAnalytics = /data analyst|data analytics|business analyst|sql|tableau|power bi|powerbi|bi analyst|eda|pandas|data visualization|scikit-learn/.test(jdLower);
  const isEmbeddedSoftware = /embedded software|firmware developer|firmware engineer|device driver|bsp|embedded c\+\+|embedded developer/.test(jdLower);
  const isEmbedded = /embedded|firmware|microcontroller|esp32|freertos|arm|cortex|mcu|uart|i2c|spi|can|iot|hardware|c\+\+|embedded c/.test(jdLower);
  
  let category = 'embedded_software';
  if (isAnalytics) category = 'data_analytics';
  else if (isEmbeddedSoftware) category = 'embedded_software';
  else if (isEmbedded) category = 'embedded';
  else category = 'python_devops';

  const embeddedSoftwarePool = ['Embedded C (C99/C11)', 'FreeRTOS Multi-Threading', 'ARM Cortex-M & ESP32', 'UART / SPI / I2C Drivers', 'CAN Protocol', 'HAL & State Machines (FSM)', 'GDB / Logic Analyzers', 'Git & Linux'];
  const embeddedPool = ['Embedded C', 'FreeRTOS', 'ESP32', 'ARM Cortex-M', 'UART / I2C / SPI', 'CAN Protocol', 'MQTT', 'Linux & Git'];
  const analyticsPool = ['Python', 'SQL (PostgreSQL/MySQL)', 'Pandas & NumPy', 'Exploratory Data Analysis (EDA)', 'Scikit-Learn & ML', 'Data Visualization (Matplotlib/Seaborn)', 'AWS Data Pipeline', 'Tableau / Power BI'];
  const pythonPool = ['Python', 'AWS (Lambda/DynamoDB)', 'Docker', 'REST APIs', 'CI/CD Pipelines', 'Linux Shell', 'Git', 'Data Structures'];

  let targetPool = embeddedSoftwarePool;
  if (category === 'data_analytics') targetPool = analyticsPool;
  else if (category === 'embedded') targetPool = embeddedPool;
  else if (category === 'python_devops') targetPool = pythonPool;

  const matched = targetPool.filter(s => jdLower.includes(s.toLowerCase().split(' ')[0]) || jdLower.includes(s.toLowerCase().split('/')[0]));
  const missing = targetPool.filter(s => !matched.includes(s)).slice(0, 2);

  const finalMatched = matched.length > 0 ? matched : targetPool.slice(0, 4);
  const score = Math.min(95, Math.max(50, 50 + finalMatched.length * 8));

  let reason = 'Strong technical match in embedded software engineering, low-level peripheral drivers, and FreeRTOS firmware architecture.';
  if (category === 'data_analytics') reason = 'Strong alignment with statistical data analysis, Python/SQL telemetry processing, and ETL data modeling.';
  else if (category === 'embedded') reason = 'Strong technical match in microcontroller interfacing, IoT systems, and hardware-software integration.';
  else if (category === 'python_devops') reason = 'Strong technical match in Python backend, cloud serverless architecture, and automated workflows.';

  return {
    matchScore: score,
    category,
    matchedSkills: finalMatched,
    missingSkills: missing,
    reasoning: reason,
    interviewTips: [
      `Review core principles of ${finalMatched[0] || 'Embedded Systems'} and real-time task scheduling.`,
      `Be prepared to explain hardware-software interfacing and defect debugging from past projects.`
    ],
    highlightedSkills: finalMatched,
    tailoredSummary: `Final-year Engineering student at Walchand Institute of Technology (9.27 CGPA) with hands-on proficiency in ${finalMatched.slice(0, 3).join(', ')}. Seeking the ${title} role to build robust, scalable solutions.`
  };
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
  const cvContext = formatCVContext(cv);
  const truncatedJD = jdText.length > 2000 ? jdText.substring(0, 2000) + '...' : jdText;

  const prompt = `You are an expert resume writer tailoring a resume for an Indian electronics and software engineering student.
Your goal is to tailor the candidate's Summary, Skills, Internship Experience bullets, and Projects to achieve a 98%+ ATS keyword match for the target job while sounding 100% human, authentic, and technically grounded.

CANDIDATE FACTUAL BACKGROUND (DO NOT INVENT FAKE DATA):
Name: Aditya Mittha | Location: Solapur / Pune, India
Education: B.Tech in Electronics & Telecommunication, Walchand Institute Of Technology (CGPA: 9.27, Graduating 2027)
Internship: Embedded Systems Intern at Codec Technologies India (Remote, May-June 2025: UART, I2C, Embedded C on MCUs, 10+ hardware defects resolved, Git)
Key Projects:
- LabPulse: Python background telemetry agent, AWS Serverless (Lambda, DynamoDB, API Gateway), Docker CI/CD
- AQUANOVA: ESP32 smart water pressure monitor, MQTT QoS 1 telemetry, ML anomaly detection, ADC/GPIO sensors
- SORTIFY: Raspberry Pi automated sorting system, Computer Vision, IoT dashboard, C & Python
Core Skills: ${cv.skills || 'Embedded C, Python, FreeRTOS, ESP32, ARM Cortex-M, UART, I2C, SPI, CAN, MQTT, AWS, Docker, Linux, Git'}

TARGET JOB TITLE: ${title}
TARGET JOB DESCRIPTION:
${truncatedJD}

STRICT WRITING RULES TO AVOID AI FOOTPRINTS:
1. NEVER use AI buzzwords or cliché corporate filler:
   BANNED WORDS: "spearheaded", "testament", "delve", "tapestry", "foster", "synergy", "cutting-edge", "multifaceted", "holistic", "dynamic landscape", "passionate", "thrilled", "esteemed", "proven track record", "demonstrated aptitude", "harnessing", "unwavering".
2. Use active, direct engineer phrasing: "Built", "Engineered", "Implemented", "Configured", "Debugged", "Integrated", "Developed".
3. Ground all bullet points in real metrics and tools.

Respond ONLY with valid JSON (no markdown, no code fences):
{
  "summary": "<2-3 sentence punchy humanized summary tailored to the JD>",
  "highlightedSkills": ["skill1", "skill2", "skill3", "skill4", "skill5", "skill6"],
  "experienceBullets": [
    "<Bullet 1 highlighting low-level drivers / protocols / tools matching JD at Codec Technologies>",
    "<Bullet 2 highlighting testing / debugging / defect resolution with real metrics>",
    "<Bullet 3 highlighting Git / workflows / embedded documentation>"
  ],
  "projectBullets": [
    "<Bullet 1 highlighting firmware / system engineering matching JD>",
    "<Bullet 2 highlighting data telemetry / cloud / analytics pipeline matching JD>"
  ]
}`;

  try {
    const raw = await callGemini(prompt, apiKey, {
      maxTokens: 2048,
      temperature: 0.2,
    });
    if (raw) {
      const result = extractJson(raw);

      if (result && result.summary && result.summary.length > 40) {
        return {
          summary: result.summary.trim(),
          highlightedSkills: Array.isArray(result.highlightedSkills) ? result.highlightedSkills : [],
          experienceBullets: Array.isArray(result.experienceBullets) ? result.experienceBullets : [],
          projectBullets: Array.isArray(result.projectBullets) ? result.projectBullets : [],
          projectFocus: category === 'embedded' ? 'AQUANOVA' : 'LabPulse',
        };
      }
    }
  } catch {}

  // High-Quality Local Synthesis Fallback (guarantees tailored ATS resume even if API quota is 429)
  return synthesizeLocalTailoredResume({ title, jdText, category, cv });
}

/**
 * Deterministic, metric-driven local multi-section resume synthesizer
 */
function synthesizeLocalTailoredResume({ title = '', jdText = '', category = 'embedded', cv = {} }) {
  const jdLower = jdText.toLowerCase();
  const allSkills = category === 'embedded'
    ? ['Embedded C', 'FreeRTOS', 'ESP32', 'ARM Cortex-M', 'UART', 'I2C', 'SPI', 'CAN Protocol', 'MQTT', 'Linux', 'Git']
    : ['Python', 'AWS (Lambda/DynamoDB)', 'Docker', 'REST APIs', 'CI/CD Pipelines', 'Linux', 'Git', 'Data Structures'];

  const matched = allSkills.filter(s => jdLower.includes(s.toLowerCase().split(' ')[0]));
  const finalSkills = matched.length >= 3 ? matched : allSkills.slice(0, 6);

  let summary = '';
  let experienceBullets = [];
  let projectBullets = [];

  if (category === 'embedded') {
    summary = `Final-year Electronics and Telecommunication Engineering student at Walchand Institute of Technology (9.27 CGPA) with hands-on firmware development experience in ${finalSkills.slice(0, 4).join(', ')}. Engineered real-time sensor communication protocols and low-level firmware during an embedded internship at Codec Technologies India and IoT projects (AQUANOVA, SORTIFY). Seeking the ${title || 'Embedded Firmware Intern'} role to build robust embedded systems.`;

    experienceBullets = [
      `Configured and tested ${finalSkills.includes('CAN Protocol') ? 'CAN and UART' : 'UART and I2C'} communication interfaces on microcontrollers, writing Embedded C code to establish reliable data transmission between peripheral modules.`,
      `Identified and resolved 10+ hardware interfacing and timing defects across two embedded sensor modules before production qualification.`,
      `Managed version control with Git across active development branches, maintaining low-level driver documentation and clean firmware workflows.`
    ];

    projectBullets = [
      `Wrote ESP32 firmware to poll pressure and flow sensors over ADC/GPIO, publishing real-time telemetry via MQTT (QoS 1) to cloud infrastructure for automated monitoring.`,
      `Built an analytics pipeline with Python to detect anomalous pressure fluctuations, decreasing estimated system troubleshooting time.`
    ];
  } else {
    summary = `Final-year Engineering student at Walchand Institute of Technology (9.27 CGPA) with hands-on proficiency in ${finalSkills.slice(0, 4).join(', ')}. Built distributed cloud telemetry agents and serverless pipelines (LabPulse) with automated Docker CI/CD workflows. Seeking the ${title || 'Python Developer'} role to engineer scalable backend and cloud solutions.`;

    experienceBullets = [
      `Developed automated Python validation scripts to parse and verify communication logs from peripheral modules during internship testing.`,
      `Optimized data serialization and reduced log processing latency across multi-branch development environments.`,
      `Collaborated using Git/GitHub workflows and automated unit testing to ensure high code reliability before deployment.`
    ];

    projectBullets = [
      `Engineered LabPulse, an automated background telemetry agent utilizing Python and AWS Serverless (Lambda, DynamoDB, API Gateway) for real-time metrics tracking.`,
      `Constructed containerized CI/CD deployment pipelines using Docker, automating testing and environment provisioning.`
    ];
  }

  return {
    summary,
    highlightedSkills: finalSkills,
    experienceBullets,
    projectBullets,
    projectFocus: category === 'embedded' ? 'AQUANOVA' : 'LabPulse',
  };
}

/**
 * Generates a tailored, punchy 3-4 sentence cover letter / application pitch
 * with zero AI footprints, customized to the JD.
 */
async function generateCoverLetter({ title = '', company = '', jdText = '', category = 'embedded', cv = {}, apiKey = '' }) {
  const cvContext = formatCVContext(cv);
  const prompt = `You are Aditya Mittha, a final-year Electronics & Telecommunication Engineering student at Walchand Institute of Technology (9.27 CGPA).
Write a direct, punchy 3-4 sentence cover letter / application pitch for:
Role: "${title}"
Company: "${company}"

CANDIDATE BACKGROUND:
${cvContext}

JOB DESCRIPTION:
${jdText.slice(0, 1800)}

STRICT RULES (Zero AI Footprints):
1. NEVER use AI buzzwords or cliché filler ("spearheaded", "testament", "delve", "tapestry", "foster", "synergy", "cutting-edge", "passionate", "thrilled", "esteemed", "proven track record").
2. Sound like a sharp, practical engineering student writing directly to a hiring manager.
3. Mention your 9.27 CGPA at Walchand, practical experience in ${category === 'embedded' ? 'FreeRTOS, Embedded C, ESP32, and hardware telemetry' : 'Python, AWS, and backend systems'}, and immediate availability in Pune / Remote.
4. Output ONLY the 3-4 sentence letter text. No greetings like "Dear Hiring Manager", no sign-offs, no placeholders.`;

  if (apiKey) {
    try {
      const raw = await callGemini(prompt, apiKey, {
        maxTokens: 1024,
        temperature: 0.25,
      });
      if (raw && raw.length > 50) {
        return raw.replace(/^["']|["']$/g, '').trim();
      }
    } catch {}
  }

  // Local fallback
  return `I am a final-year Electronics and Telecommunication Engineering student at Walchand Institute of Technology (9.27 CGPA) with hands-on experience in ${category === 'embedded' ? 'Embedded C, FreeRTOS, ESP32 microcontrollers, and UART/I2C protocols' : 'Python, AWS Serverless architecture, and Docker'}. I have developed production-grade projects including ${category === 'embedded' ? 'AQUANOVA and MCU firmware at Codec Technologies' : 'LabPulse telemetry pipeline'} and am seeking the ${title || 'Engineering Intern'} opportunity at ${company || 'your team'}. I am available immediately for full-time work in Pune / Remote.`;
}

/**
 * AI-Powered Career Page Form Field Resolver.
 * Resolves any custom field, open-ended question, select dropdown, radio group,
 * or number input on company career pages (Workday, Greenhouse, Lever, Ashby, etc.).
 *
 * @param {object} fieldInfo - { label, name, type, options, placeholder, company, jobTitle }
 * @param {object} cv - CV object from config.js
 * @param {string} apiKey - Gemini API key
 * @returns {Promise<string|null>}
 */
async function answerCareerPageField(fieldInfo, cv, apiKey) {
  const { label = '', name = '', type = 'text', options = [], placeholder = '', company = '', jobTitle = '' } = fieldInfo;
  const combinedPromptText = `${label} ${name} ${placeholder}`.toLowerCase();

  // Fast direct resolution for standard patterns
  if (/gender/i.test(combinedPromptText)) return cv.gender || 'Male';
  if (/citizenship|nationality/i.test(combinedPromptText)) return 'Indian';
  if (/authorized|legally authorized|work authorization|eligible to work/i.test(combinedPromptText)) {
    if (options.length > 0) {
      const yesOpt = options.find(o => /^yes\b/i.test(o)) || options[0];
      return yesOpt;
    }
    return 'Yes';
  }
  if (/sponsorship|require.*visa|need.*visa/i.test(combinedPromptText)) {
    if (options.length > 0) {
      const noOpt = options.find(o => /^no\b/i.test(o)) || options[0];
      return noOpt;
    }
    return 'No';
  }
  if (/notice period|how soon|availability|start date/i.test(combinedPromptText)) {
    if (options.length > 0) {
      const match = options.find(o => /immediate|30|1 month|< 1 month/i.test(o));
      if (match) return match;
    }
    return cv.noticePeriod || 'Immediate / 30 days';
  }
  if (/relocate|relocation/i.test(combinedPromptText)) {
    if (options.length > 0) {
      const yesOpt = options.find(o => /^yes\b/i.test(o)) || options[0];
      return yesOpt;
    }
    return 'Yes, open to relocation';
  }
  if (/current.*ctc|current.*salary|present.*ctc/i.test(combinedPromptText)) {
    return String(cv.currentCTC || '0');
  }
  if (/expected.*ctc|expected.*salary|compensation.*expectation|desired.*salary/i.test(combinedPromptText)) {
    if (options.length > 0) {
      const match = options.find(o => /6|7|8|10|fresh|entry/i.test(o));
      if (match) return match;
    }
    return String(cv.expectedCTC || '6-10 LPA');
  }
  if (/years of experience|total experience|work experience/i.test(combinedPromptText)) {
    if (type === 'number' || /number/i.test(type)) return '0';
    if (options.length > 0) {
      const freshOpt = options.find(o => /0|fresh|entry|1|< 1/i.test(o));
      if (freshOpt) return freshOpt;
    }
    return cv.yearsOfExperience || 'Fresher / 0-1 years';
  }
  if (/how did you (hear|find)|source/i.test(combinedPromptText)) {
    if (options.length > 0) {
      const match = options.find(o => /linkedin|job board|careers|online|other/i.test(o));
      if (match) return match;
    }
    return 'Company Careers Page / LinkedIn';
  }

  // AI-Powered contextual reasoning
  const cvContext = formatCVContext(cv);
  const optionsBlock = options.length > 0
    ? `\nOPTIONS AVAILABLE (You MUST pick EXACTLY ONE from this list):\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}\nReturn ONLY the exact option string.`
    : `\nAnswer concisely in 1-2 natural sentences representing the candidate. Never use clichés or AI filler.`;

  const prompt = `You are ${cv.name}, applying for "${jobTitle || 'Engineering Role'}" at "${company || 'Company'}".
Answer this career page application form field truthfully based on your profile.

FIELD LABEL / QUESTION: "${label || name || placeholder}"
FIELD TYPE: ${type}
${optionsBlock}

YOUR CANDIDATE PROFILE:
${cvContext}

Answer directly with zero extra commentary:`;

  if (apiKey) {
    try {
      const raw = await callGemini(prompt, apiKey, { maxTokens: 500, temperature: 0.15 });
      if (raw) {
        let cleaned = raw.trim().replace(/^["']|["']$/g, '');
        if (options.length > 0) {
          const exact = options.find(o => o.toLowerCase() === cleaned.toLowerCase());
          if (exact) return exact;
          const partial = options.find(o => cleaned.toLowerCase().includes(o.toLowerCase()) || o.toLowerCase().includes(cleaned.toLowerCase()));
          if (partial) return partial;
          return options[0];
        }
        return cleaned;
      }
    } catch {}
  }

  if (options.length > 0) return options[0];
  return 'Yes';
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
  answerCareerPageField,
  tailorResumeSummary,
  tailorFullResume,
  generateCoverLetter,
  formatCVContext,
};



