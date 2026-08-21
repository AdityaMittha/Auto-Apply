/**
 * Tailor Engine — Hybrid keyword + Gemini AI analysis.
 *
 * analyzeJob()         → Fast keyword check, then optional AI refinement
 * answerQuestion()     → Regex fast-path for common Qs, AI for everything else
 * getResumeForCategory() → Maps category → resume PDF path
 */
const path = require('path');
const {
  analyzeJobWithAI,
  answerScreeningQuestion,
  tailorResumeSummary,
} = require('./gemini-ai');

const RESUMES = {
  embedded: path.join(__dirname, 'resume', 'Mittha_Aditya_Embedded.pdf'),
  python_devops: path.join(__dirname, 'resume', 'Mittha_Aditya.pdf'),
  default: path.join(__dirname, 'resume', 'Mittha_Aditya_Embedded.pdf'),
};

const EMBEDDED_KEYWORDS = [
  'embedded', 'firmware', 'c', 'embedded c', 'c++', 'microcontroller', 'mcu',
  'arm', 'cortex', 'esp32', 'arduino', 'raspberry pi', 'rtos', 'freertos',
  'uart', 'spi', 'i2c', 'can', 'mqtt', 'gpio', 'adc', 'sensor', 'sensors',
  'iot', 'hardware', 'pcb', 'bare-metal', 'logic analyzer', 'verilog',
  'device driver', 'telemetry', 'zigbee', 'ble', 'bluetooth'
];

const PYTHON_DEVOPS_KEYWORDS = [
  'python', 'devops', 'aws', 'lambda', 'dynamodb', 'api gateway', 's3',
  'docker', 'container', 'ci/cd', 'github actions', 'cloud', 'backend',
  'automation', 'bash', 'shell', 'linux', 'ubuntu', 'rest api', 'fastapi',
  'flask', 'django', 'pandas', 'numpy', 'scikit-learn', 'machine learning'
];

/**
 * Fast keyword-based analysis (no API call, instant).
 * Used as the primary analysis and as fallback when AI is unavailable.
 */
function keywordAnalysis(title = '', jdText = '', requiredSkills = []) {
  const content = `${title} ${requiredSkills.join(' ')} ${jdText}`.toLowerCase();

  let embeddedMatches = 0;
  const matchedEmbedded = [];
  for (const kw of EMBEDDED_KEYWORDS) {
    if (content.includes(kw)) {
      embeddedMatches++;
      matchedEmbedded.push(kw);
    }
  }

  let pythonMatches = 0;
  const matchedPython = [];
  for (const kw of PYTHON_DEVOPS_KEYWORDS) {
    if (content.includes(kw)) {
      pythonMatches++;
      matchedPython.push(kw);
    }
  }

  const totalMatches = embeddedMatches + pythonMatches;
  let category = 'embedded';
  let selectedResume = RESUMES.embedded;

  if (pythonMatches > embeddedMatches && !content.includes('embedded') && !content.includes('firmware')) {
    category = 'python_devops';
    selectedResume = RESUMES.python_devops;
  } else {
    category = 'embedded';
    selectedResume = RESUMES.embedded;
  }

  // Calculate score (0 - 100) based on keyword density & relevant hits
  const matchScore = Math.min(100, Math.round((totalMatches / 8) * 100));

  return {
    category,
    matchScore: Math.max(matchScore, totalMatches > 0 ? 50 : 20),
    matchedKeywords: category === 'embedded' ? matchedEmbedded : matchedPython,
    selectedResume,
    resumeName: path.basename(selectedResume),
    // AI fields (empty for keyword-only)
    matchedSkills: [],
    missingSkills: [],
    reasoning: '',
    aiEnhanced: false,
  };
}

/**
 * Hybrid job analysis — fast keyword check + optional AI refinement.
 *
 * 1. Always runs keyword analysis first (instant, no API cost)
 * 2. If AI is enabled and an API key is provided, calls Gemini for:
 *    - Calibrated match score
 *    - Semantic skill matching
 *    - Missing skills identification
 *    - Reasoning
 * 3. If AI fails, returns keyword-only result seamlessly
 *
 * @param {string} title - Job title
 * @param {string} jdText - Full job description text
 * @param {string[]} requiredSkills - Tags/skills from the job listing
 * @param {object} [opts] - { cv, geminiKey, aiEnabled }
 * @returns {Promise<object>} Analysis result
 */
async function analyzeJob(title = '', jdText = '', requiredSkills = [], opts = {}) {
  const { cv, geminiKey, aiEnabled = true } = opts;

  // Step 1: Fast keyword analysis (always runs)
  const kwResult = keywordAnalysis(title, jdText, requiredSkills);

  // Step 2: AI refinement (optional)
  if (!aiEnabled || !geminiKey || !cv) {
    return kwResult;
  }

  try {
    const aiResult = await analyzeJobWithAI(title, jdText, cv, geminiKey);
    if (!aiResult) return kwResult;

    // Merge: Use AI score but keep keyword-selected resume
    const category = aiResult.category || kwResult.category;
    const selectedResume = RESUMES[category] || RESUMES[kwResult.category] || RESUMES.default;

    return {
      category,
      matchScore: aiResult.matchScore,
      matchedKeywords: kwResult.matchedKeywords,
      selectedResume,
      resumeName: path.basename(selectedResume),
      // AI-enhanced fields
      matchedSkills: aiResult.matchedSkills,
      missingSkills: aiResult.missingSkills,
      reasoning: aiResult.reasoning,
      aiEnhanced: true,
    };
  } catch {
    // AI failed — return keyword-only result
    return kwResult;
  }
}

/**
 * Resolves screening / chatbot questions.
 *
 * Strategy:
 *   1. Regex fast-path for the most common questions (saves API calls)
 *   2. AI-powered answering for everything else
 *   3. Generic fallback if both fail
 */
async function answerQuestion(questionText = '', options = [], cv = {}, geminiKey = '') {
  const q = questionText.toLowerCase();

  // ── Fast-path: Common questions (no API call needed) ──────────────

  // Notice Period
  if (/notice|how soon|availability|join/i.test(q)) {
    if (options.length > 0) {
      const match = options.find(o => /immediate|0|15|1 month|< 15|available/i.test(o));
      if (match) return match;
    }
    return cv.noticePeriod || 'Immediate (within 15 days)';
  }

  // Current CTC / Salary
  if (/current ctc|current salary|fixed salary|current compensation/i.test(q)) {
    if (options.length > 0) {
      const match = options.find(o => /0|fresher|na|not applicable|< 1/i.test(o));
      if (match) return match;
    }
    return cv.currentCTC || '0';
  }

  // Expected CTC / Salary
  if (/expected ctc|expected salary|salary expectation|compensation expectation/i.test(q)) {
    if (options.length > 0) {
      const match = options.find(o => /3|4|5|6|negotiable|as per industry/i.test(o));
      if (match) return match;
    }
    return cv.expectedSalary || 'As per industry standards / Negotiable';
  }

  // Experience
  if (/experience|years of exp|how many years/i.test(q)) {
    if (options.length > 0) {
      const match = options.find(o => /0|fresher|0-1|< 1|1/i.test(o));
      if (match) return match;
    }
    return '0-1 years (Fresher with Internship experience)';
  }

  // Education / Graduation Year / Degree
  if (/graduation|degree|qualification|highest education|college|passout|batch/i.test(q)) {
    if (options.length > 0) {
      const match = options.find(o => /b\.?tech|b\.?e|engineering|2027|2026/i.test(o));
      if (match) return match;
    }
    return cv.education || 'B.Tech in Electronics & Telecommunication';
  }

  // Relocation / Location / Remote
  if (/relocate|relocation|current location|preferred location|onsite|hybrid|remote/i.test(q)) {
    if (options.length > 0) {
      const match = options.find(o => /yes|pune|solapur|any|open/i.test(o));
      if (match) return match;
    }
    return cv.relocate || 'Yes, open to relocation.';
  }

  // Work Authorization / Gender
  if (/work auth|authorized|legally/i.test(q)) return cv.workAuth || 'Authorized to work in India.';
  if (/gender/i.test(q)) return cv.gender || 'Male';

  // Yes/No skill proficiency questions
  if (/do you have|are you proficient|hands-on|experience in/i.test(q)) {
    if (options.length > 0) {
      const yesOpt = options.find(o => /^yes/i.test(o));
      if (yesOpt) return yesOpt;
    }
    return 'Yes, have hands-on project and internship experience in this domain.';
  }

  // Option matching fallback (before AI, to save API calls on trivial MCQs)
  if (options.length > 0) {
    const positiveOpt = options.find(o => !/none|no|not/i.test(o)) || options[0];
    // Only use this for simple 2-3 option MCQs — for complex questions, let AI handle it
    if (options.length <= 3) return positiveOpt;
  }

  // ── AI-powered answering (for complex/unmatched questions) ────────

  if (geminiKey) {
    try {
      const aiAnswer = await answerScreeningQuestion(questionText, options, cv, geminiKey);
      if (aiAnswer) return aiAnswer;
    } catch {
      // fall through to generic
    }
  }

  // ── Generic fallback ──────────────────────────────────────────────
  return 'Yes, have relevant experience with demonstrated academic and project accomplishments.';
}

module.exports = {
  analyzeJob,
  answerQuestion,
  tailorResumeSummary,
  keywordAnalysis,
  RESUMES,
};
