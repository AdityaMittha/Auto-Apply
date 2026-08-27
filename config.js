/**
 * Loads all personal data + credentials from .env so nothing sensitive lives in code.
 * Tiny hand-rolled parser — no dependency needed for a flat KEY=value file.
 */
const fs = require('fs');
const path = require('path');

function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const E = loadEnv(path.join(__dirname, '.env'));
const g = (k, d = '') => (E[k] != null && E[k] !== '' ? E[k] : (process.env[k] || d));

if (!g('NAME') || !g('EMAIL')) {
  console.warn('[config] .env missing or empty — copy .env.example to .env and fill it in.');
}

const CV = {
  name: g('NAME'),
  email: g('EMAIL'),
  phone: g('PHONE'),
  location: g('LOCATION'),
  summary: g('SUMMARY'),
  currentRole: g('CURRENT_ROLE'),
  company: g('COMPANY') || (g('CURRENT_ROLE').split(' at ')[1] || '').split(' (')[0],
  education: g('EDUCATION'),
  yearsOfExperience: g('YEARS_EXPERIENCE'),
  skills: g('SKILLS'),
  highlights: g('HIGHLIGHTS').split('||').map((s) => s.trim()).filter(Boolean),
  // application answers
  noticePeriod: g('NOTICE_PERIOD'),
  currentCTC: g('CURRENT_CTC'),                 // bare number for chatbots, e.g. "10"
  expectedCTC: g('EXPECTED_CTC'),               // e.g. "18-25"
  currentSalary: g('CURRENT_CTC') + ' LPA',     // formatted for free-text fields
  expectedSalary: g('EXPECTED_CTC') + ' LPA',
  dob: g('DOB'),
  gender: g('GENDER'),
  workAuth: g('WORK_AUTH', 'Authorized to work in my country of residence.'),
  // links
  github: g('GITHUB_URL'),
  linkedin: g('LINKEDIN_URL'),
  portfolio: g('PORTFOLIO_URL'),
  links: `GitHub: ${g('GITHUB_URL')} | LinkedIn: ${g('LINKEDIN_URL')} | Portfolio: ${g('PORTFOLIO_URL')}`,
  // derived sentences
  remoteOk: 'Yes, I am fully set up for remote work and also open to hybrid/onsite.',
  relocate: `Yes, I am open to relocation. I am currently based in ${g('LOCATION')}.`,
  startDate: `I can start within ${g('NOTICE_PERIOD')}.`,
};

const CREDS = { email: g('GOOGLE_EMAIL') || g('EMAIL'), password: g('GOOGLE_PASSWORD') };
const geminiKey = g('GEMINI_KEY');
const naukriProfileUrl = g('NAUKRI_PROFILE_URL', 'https://www.naukri.com/mnjuser/profile');

// AI Configuration
const aiConfig = {
  enabled: g('AI_ENABLED', 'true').toLowerCase() === 'true',
  model: g('GEMINI_MODEL', 'gemini-2.0-flash'),
  timeoutMs: parseInt(g('AI_TIMEOUT_MS', '15000'), 10),
};

const autoApplyConfig = {
  keywords: g('AUTO_APPLY_KEYWORDS', 'Embedded Software Engineer, Embedded Software Developer, Firmware Engineer, Embedded Systems Intern, Python Developer, IoT Intern, Embedded C, Data Analyst').split(',').map(s => s.trim()).filter(Boolean),
  locations: g('AUTO_APPLY_LOCATIONS', 'Pune, Remote, Solapur').split(',').map(s => s.trim()).filter(Boolean),
  experience: g('AUTO_APPLY_EXPERIENCE', '0'),
  maxPerRun: parseInt(g('AUTO_APPLY_MAX_PER_RUN', '10'), 10),
  minMatchScore: parseInt(g('AUTO_APPLY_MIN_MATCH_SCORE', '50'), 10),
  domainMatchScore: parseInt(g('AUTO_APPLY_DOMAIN_MATCH_SCORE', '50'), 10),
  dryRun: g('DRY_RUN', 'false').toLowerCase() === 'true',
};

// Allowed locations for filtering — only apply to jobs in these cities or remote
const ALLOWED_LOCATIONS = g('ALLOWED_LOCATIONS', 'Pune, Remote, Solapur, Work from Home, WFH, Anywhere, Work From Home')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

/**
 * Checks if a job's location string matches any allowed location.
 * Case-insensitive, partial-match (e.g. "Pune, Maharashtra" matches "pune").
 * @param {string} locationStr - The job's location text from the portal
 * @returns {boolean}
 */
function isLocationAllowed(locationStr) {
  if (!locationStr) return false;
  const loc = locationStr.toLowerCase();
  return ALLOWED_LOCATIONS.some(allowed => loc.includes(allowed));
}

/**
 * Checks if a job belongs to target technical industry / department domains.
 * @param {string} title
 * @param {string} jdText
 * @param {string} category
 * @returns {boolean}
 */
function isIndustryMatched(title = '', jdText = '', category = '') {
  const text = `${title} ${jdText} ${category}`.toLowerCase();
  const targetDomains = [
    // Embedded, Firmware, Hardware & Electronics
    'embedded', 'firmware', 'microcontroller', 'mcu', 'esp32', 'arm', 'cortex', 'arduino', 'raspberry pi',
    'freertos', 'rtos', 'uart', 'spi', 'i2c', 'can', 'can bus', 'mqtt', 'iot', 'hardware', 'pcb', 'electronics',
    'e&tc', 'mechatronics', 'robotics', 'telecom', 'telecommunication', 'vlsi', 'verilog', 'fpga', 'sensor',
    'device driver', 'bare-metal', 'stem', 'logic analyzer',
    // Software, Python, Cloud, DevOps & Backend
    'python', 'devops', 'backend', 'cloud', 'aws', 'docker', 'linux', 'software', 'developer', 'engineer',
    'django', 'flask', 'fastapi', 'rest api', 'automation', 'data science', 'machine learning', 'ai', 'data structures',
    // Data Analytics, Business Intelligence & SQL
    'data analyst', 'data analytics', 'data science', 'business analyst', 'business intelligence', 'bi analyst',
    'sql', 'pandas', 'numpy', 'tableau', 'power bi', 'powerbi', 'eda', 'matplotlib', 'seaborn', 'statistics',
    'etl', 'data pipeline', 'data wrangling', 'scikit-learn'
  ];
  return targetDomains.some(kw => text.includes(kw));
}

/**
 * Computes dynamic minimum match score: 50% if industry/department is matched.
 * @param {string} title
 * @param {string} jdText
 * @param {string} category
 * @returns {number}
 */
function getEffectiveMinScore(title = '', jdText = '', category = '') {
  if (isIndustryMatched(title, jdText, category)) {
    return autoApplyConfig.domainMatchScore || 50;
  }
  return autoApplyConfig.minMatchScore || 50;
}

module.exports = {
  CV,
  CREDS,
  geminiKey,
  naukriProfileUrl,
  autoApplyConfig,
  aiConfig,
  isLocationAllowed,
  isIndustryMatched,
  getEffectiveMinScore,
  ALLOWED_LOCATIONS
};

