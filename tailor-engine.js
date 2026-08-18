/**
 * Tailor Engine — analyzes Job Descriptions (JDs), selects the best-matching
 * tailored resume PDF, calculates compatibility score, and generates smart
 * screening question responses.
 */
const path = require('path');
const https = require('https');

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
 * Evaluates a Job Description and Title to calculate match score, domain category,
 * and select the best tailored resume PDF.
 */
function analyzeJob(title = '', jdText = '', requiredSkills = []) {
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
  };
}

/**
 * Resolves screening / chatbot questions automatically using CV data.
 */
async function answerQuestion(questionText = '', options = [], cv = {}, geminiKey = '') {
  const q = questionText.toLowerCase();

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
    return '0-1 years (Fresher with Internship experience at Codec Technologies)';
  }

  // Education / Graduation Year / Degree
  if (/graduation|degree|qualification|highest education|college|passout|batch/i.test(q)) {
    if (options.length > 0) {
      const match = options.find(o => /b\.?tech|b\.?e|engineering|2027|2026/i.test(o));
      if (match) return match;
    }
    return 'B.Tech in Electronics & Telecommunication (Walchand Institute of Technology, 2027, CGPA: 9.27)';
  }

  // Relocation / Location / Remote
  if (/relocate|relocation|current location|preferred location|onsite|hybrid|remote/i.test(q)) {
    if (options.length > 0) {
      const match = options.find(o => /yes|pune|solapur|any|open/i.test(o));
      if (match) return match;
    }
    return 'Yes, open to relocation. Currently based in Solapur/Pune.';
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

  // Option matching fallback
  if (options.length > 0) {
    const firstOpt = options.find(o => !/none|no|not/i.test(o)) || options[0];
    return firstOpt;
  }

  // Gemini AI fallback for complex open-ended screening questions
  if (geminiKey) {
    try {
      const aiAnswer = await askGemini(questionText, cv, geminiKey);
      if (aiAnswer) return aiAnswer;
    } catch (err) {
      // fallback to default
    }
  }

  return 'Yes, have relevant experience with demonstrated academic and project accomplishments.';
}

/**
 * Optional Gemini API caller for open-ended screening questions.
 */
function askGemini(prompt, cv, apiKey) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      contents: [{
        parts: [{
          text: `You are Aditya Mittha, a final-year Electronics & Telecommunication student (CGPA 9.27) at Walchand Institute of Technology with skills in Embedded Systems (Embedded C, FreeRTOS, ESP32, ARM, UART, I2C, SPI, MQTT) and Python (AWS, Docker, Linux). Answer the following job application question concisely, professionally, and authentically in 1-2 sentences:\n\nQuestion: "${prompt}"`
        }]
      }],
      generationConfig: { maxOutputTokens: 120, temperature: 0.2 }
    });

    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', (d) => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const answer = parsed.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          resolve(answer || null);
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

module.exports = {
  analyzeJob,
  answerQuestion,
  RESUMES,
};
