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
const { tailorAndCompileResume } = require('./resume-compiler');

const RESUMES = {
  embedded: path.join(__dirname, 'resume', 'Mittha_Aditya_Embedded.pdf'),
  embedded_software: path.join(__dirname, 'resume', 'Mittha_Aditya_Embedded_Software.pdf'),
  python_devops: path.join(__dirname, 'resume', 'Mittha_Aditya.pdf'),
  data_analytics: path.join(__dirname, 'resume', 'Mittha_Aditya_Data_Analytics.pdf'),
  default: path.join(__dirname, 'resume', 'Mittha_Aditya_Embedded_Software.pdf'),
};

const EMBEDDED_KEYWORDS = [
  'embedded', 'firmware', 'c', 'embedded c', 'c++', 'microcontroller', 'mcu',
  'arm', 'cortex', 'cortex-m', 'stm32', 'esp32', 'arduino', 'raspberry pi', 'rtos', 'freertos',
  'uart', 'spi', 'i2c', 'can', 'can bus', 'mqtt', 'gpio', 'adc', 'dac', 'pwm', 'sensor', 'sensors',
  'iot', 'hardware', 'pcb', 'bare-metal', 'logic analyzer', 'verilog', 'fpga', 'mechatronics',
  'device driver', 'telemetry', 'zigbee', 'ble', 'bluetooth', 'robotics', 'electronics', 'e&tc', 'telecom', 'stem'
];

const EMBEDDED_SOFTWARE_KEYWORDS = [
  'embedded software', 'embedded software engineer', 'embedded software developer', 'firmware engineer',
  'firmware developer', 'device driver', 'bsp', 'board support package', 'hal', 'hardware abstraction',
  'embedded c', 'embedded c++', 'freertos', 'rtos', 'bare-metal', 'state machine', 'fsm', 'ring buffer',
  'arm cortex', 'stm32', 'esp32', 'esp-idf', 'isr', 'interrupt', 'misra', 'gdb', 'openocd', 'jtag', 'swd'
];

const DATA_ANALYTICS_KEYWORDS = [
  'data analyst', 'data analytics', 'data science', 'data scientist', 'business analyst',
  'business intelligence', 'bi analyst', 'bi developer', 'sql', 'pandas', 'numpy', 'scipy',
  'tableau', 'power bi', 'powerbi', 'eda', 'exploratory data analysis', 'statistics', 'statistical',
  'matplotlib', 'seaborn', 'plotly', 'excel', 'pivot table', 'data visualization', 'data cleaning',
  'data wrangling', 'etl', 'data pipeline', 'feature engineering', 'scikit-learn', 'data modeling',
  'time-series', 'forecasting', 'anomaly detection', 'data engineering', 'analytics intern'
];

const PYTHON_DEVOPS_KEYWORDS = [
  'python', 'devops', 'aws', 'lambda', 'dynamodb', 'api gateway', 's3', 'iot core',
  'docker', 'container', 'ci/cd', 'github actions', 'cloud', 'backend', 'full stack',
  'automation', 'bash', 'shell', 'linux', 'ubuntu', 'rest api', 'api', 'fastapi',
  'flask', 'django', 'pandas', 'numpy', 'scikit-learn', 'machine learning', 'data structures',
  'software', 'developer', 'engineer', 'git', 'github', 'testing', 'postman'
];

/**
 * Fast keyword-based analysis (no API call, instant).
 * Used as the primary analysis and as fallback when AI is unavailable.
 */
function keywordAnalysis(title = '', jdText = '', requiredSkills = []) {
  const content = `${title} ${requiredSkills.join(' ')} ${jdText}`.toLowerCase();

  let embeddedSoftwareMatches = 0;
  const matchedEmbeddedSoftware = [];
  for (const kw of EMBEDDED_SOFTWARE_KEYWORDS) {
    if (content.includes(kw)) {
      embeddedSoftwareMatches++;
      matchedEmbeddedSoftware.push(kw);
    }
  }

  let embeddedMatches = 0;
  const matchedEmbedded = [];
  for (const kw of EMBEDDED_KEYWORDS) {
    if (content.includes(kw)) {
      embeddedMatches++;
      matchedEmbedded.push(kw);
    }
  }

  let analyticsMatches = 0;
  const matchedAnalytics = [];
  for (const kw of DATA_ANALYTICS_KEYWORDS) {
    if (content.includes(kw)) {
      analyticsMatches++;
      matchedAnalytics.push(kw);
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

  let category = 'embedded_software';
  let selectedResume = RESUMES.embedded_software;

  const isExplicitAnalytics = content.includes('data analyst') || content.includes('data analytics') || content.includes('business analyst') || content.includes('bi ') || content.includes('tableau') || content.includes('power bi');
  const isExplicitEmbeddedSoftware = content.includes('embedded software') || content.includes('firmware developer') || content.includes('firmware engineer') || content.includes('device driver') || content.includes('embedded c++') || content.includes('bsp');

  if (isExplicitAnalytics || (analyticsMatches > embeddedMatches && analyticsMatches > pythonMatches && analyticsMatches > embeddedSoftwareMatches)) {
    category = 'data_analytics';
    selectedResume = RESUMES.data_analytics;
  } else if (isExplicitEmbeddedSoftware || embeddedSoftwareMatches > 0 || (content.includes('embedded') && (content.includes('software') || content.includes('developer') || content.includes('engineer')))) {
    category = 'embedded_software';
    selectedResume = RESUMES.embedded_software;
  } else if (pythonMatches > embeddedMatches && !content.includes('embedded') && !content.includes('firmware') && !content.includes('microcontroller')) {
    category = 'python_devops';
    selectedResume = RESUMES.python_devops;
  } else {
    category = 'embedded';
    selectedResume = RESUMES.embedded;
  }

  // Calculate realistic, continuous score (50 - 95% for domain hits)
  let hits = matchedEmbeddedSoftware.length > 0 ? matchedEmbeddedSoftware : matchedEmbedded;
  if (category === 'data_analytics') hits = matchedAnalytics;
  else if (category === 'python_devops') hits = matchedPython;
  else if (category === 'embedded') hits = matchedEmbedded;

  const uniqueHits = new Set(hits).size;
  let matchScore = 50;
  if (uniqueHits > 0) {
    matchScore = Math.min(95, Math.max(50, 50 + Math.round((uniqueHits / 5) * 45)));
  }

  return {
    category,
    matchScore,
    matchedKeywords: hits,
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
  const { cv, geminiKey, aiEnabled = true, jobId = '' } = opts;

  // Step 1: Fast keyword analysis (always runs)
  const kwResult = keywordAnalysis(title, jdText, requiredSkills);

  let finalCategory = kwResult.category;
  let finalMatchScore = kwResult.matchScore;
  let matchedSkills = [];
  let missingSkills = [];
  let reasoning = '';
  let interviewTips = [];
  let highlightedSkills = [];
  let aiEnhanced = false;

  // Step 2: AI refinement (or deterministic local model)
  if (aiEnabled && cv) {
    try {
      const aiResult = await analyzeJobWithAI(title, jdText, cv, geminiKey);
      if (aiResult) {
        finalCategory = aiResult.category || kwResult.category;
        finalMatchScore = aiResult.matchScore;
        matchedSkills = aiResult.matchedSkills || [];
        missingSkills = aiResult.missingSkills || [];
        reasoning = aiResult.reasoning || '';
        interviewTips = aiResult.interviewTips || [];
        highlightedSkills = aiResult.highlightedSkills || [];
        aiEnhanced = true;
      }
    } catch {
      // AI failed — keep keyword results
    }
  }

  // Step 3: Compile / Select Tailored Resume
  let selectedResume = RESUMES[finalCategory] || RESUMES.default;
  let tailoredResumePath = selectedResume;
  let s3Key = null;
  let s3Url = null;
  let isTailored = false;
  let tailoredSummary = '';

  try {
    const tailoredRes = await tailorAndCompileResume({
      jobId: jobId || title,
      jobTitle: title,
      jdText,
      category: finalCategory,
      cv,
      apiKey: geminiKey,
    });
    if (tailoredRes && tailoredRes.pdfPath) {
      tailoredResumePath = tailoredRes.pdfPath;
      selectedResume = tailoredRes.pdfPath;
      s3Key = tailoredRes.s3Key || null;
      s3Url = tailoredRes.s3Url || null;
      isTailored = tailoredRes.isTailored;
      tailoredSummary = tailoredRes.tailoredSummary || '';
    }
  } catch {}

  return {
    category: finalCategory,
    matchScore: finalMatchScore,
    matchedKeywords: kwResult.matchedKeywords,
    selectedResume,
    tailoredResumePath,
    s3Key,
    s3Url,
    resumeName: path.basename(selectedResume),
    isTailored,
    // AI-enhanced & insight fields
    matchedSkills,
    missingSkills,
    reasoning,
    interviewTips,
    highlightedSkills,
    tailoredSummary,
    aiEnhanced,
  };
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
