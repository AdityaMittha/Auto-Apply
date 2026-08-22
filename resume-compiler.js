/**
 * Resume Compiler Module
 * 
 * Dynamically tailors the LaTeX resume Summary, Skills, and Projects per Job Description (JD),
 * compiles the customized LaTeX into a clean ATS-friendly PDF using pdflatex,
 * uploads to Amazon S3, and generates secure pre-signed download URLs.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { tailorFullResume } = require('./gemini-ai');
const { CV, geminiKey, aiConfig } = require('./config');
const { uploadFile, getPresignedDownloadUrl, S3_BUCKET } = require('./s3-storage');

const RESUME_DIR = path.join(__dirname, 'resume');
const TAILORED_DIR = path.join(RESUME_DIR, 'tailored');

const BASE_TEX_FILES = {
  embedded: path.join(RESUME_DIR, 'Aditya_Mittha_Embedded.tex'),
  python_devops: path.join(RESUME_DIR, 'Aditya_Mittha.tex'),
  default: path.join(RESUME_DIR, 'Aditya_Mittha_Embedded.tex'),
};

const STATIC_PDFS = {
  embedded: path.join(RESUME_DIR, 'Mittha_Aditya_Embedded.pdf'),
  python_devops: path.join(RESUME_DIR, 'Mittha_Aditya.pdf'),
  default: path.join(RESUME_DIR, 'Mittha_Aditya_Embedded.pdf'),
};

// Ensure tailored directory exists
if (!fs.existsSync(TAILORED_DIR)) {
  fs.mkdirSync(TAILORED_DIR, { recursive: true });
}

/**
 * Escapes common LaTeX special characters in AI-generated text.
 * @param {string} text 
 * @returns {string}
 */
function escapeLatex(text = '') {
  if (!text) return '';
  return text
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/"([^"]*)"/g, "``$1''")
    .replace(/---/g, '---')
    .replace(/--/g, '--');
}

/**
 * Extracts current summary text from a .tex file.
 * @param {string} texContent 
 * @returns {string}
 */
function extractSummaryFromTex(texContent) {
  const match = texContent.match(/\\section\{Summary\}\s*(?:\\small\s*)?([\s\S]*?)(?=\\vspace|\\section)/i);
  return match ? match[1].trim() : '';
}

/**
 * Checks if pdflatex or xelatex is available in system PATH.
 * @returns {string|null} 'pdflatex' | 'xelatex' | null
 */
function getLatexEngine() {
  try {
    const cmd = process.platform === 'win32' ? 'where.exe pdflatex' : 'which pdflatex';
    execSync(cmd, { stdio: 'ignore' });
    return 'pdflatex';
  } catch {
    try {
      const cmd = process.platform === 'win32' ? 'where.exe xelatex' : 'which xelatex';
      execSync(cmd, { stdio: 'ignore' });
      return 'xelatex';
    } catch {
      return null;
    }
  }
}

/**
 * Tailors LaTeX resume and compiles it to PDF, uploading to S3 if available.
 *
 * @param {object} params
 * @param {string} params.jobId - Unique job identifier or clean title
 * @param {string} params.jobTitle - Job title
 * @param {string} params.jdText - Job description text
 * @param {string} params.category - 'embedded' | 'python_devops' | 'general'
 * @param {object} [params.cv] - CV profile data
 * @param {string} [params.apiKey] - Gemini API Key
 * @returns {Promise<{ pdfPath: string, s3Key: string|null, s3Url: string|null, texPath: string|null, tailoredSummary: string, isTailored: boolean }>}
 */
async function tailorAndCompileResume({
  jobId = '',
  jobTitle = '',
  jdText = '',
  category = 'embedded',
  cv = CV,
  apiKey = geminiKey,
}) {
  const normCategory = category === 'python_devops' ? 'python_devops' : 'embedded';
  const baseTexPath = BASE_TEX_FILES[normCategory] || BASE_TEX_FILES.default;
  const staticPdf = STATIC_PDFS[normCategory] || STATIC_PDFS.default;

  // Sanitize jobId for filename
  const cleanId = (jobId || jobTitle || 'job')
    .replace(/^https?:\/\//i, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .slice(0, 50);

  const targetPdf = path.join(TAILORED_DIR, `Resume_${normCategory}_${cleanId}.pdf`);
  const targetTex = path.join(TAILORED_DIR, `Resume_${normCategory}_${cleanId}.tex`);
  const s3Key = `resumes/tailored/Resume_${normCategory}_${cleanId}.pdf`;

  // If already compiled for this exact jobId, reuse it and generate S3 presigned URL
  if (fs.existsSync(targetPdf) && fs.statSync(targetPdf).size > 1000) {
    let s3Url = null;
    try {
      s3Url = await getPresignedDownloadUrl(s3Key);
    } catch {}
    return {
      pdfPath: targetPdf,
      s3Key,
      s3Url,
      texPath: fs.existsSync(targetTex) ? targetTex : null,
      tailoredSummary: '(Cached tailored resume)',
      isTailored: true,
    };
  }

  // Verify base .tex exists
  if (!fs.existsSync(baseTexPath)) {
    return {
      pdfPath: staticPdf,
      s3Key: null,
      s3Url: null,
      texPath: null,
      tailoredSummary: '',
      isTailored: false,
    };
  }

  let texContent = fs.readFileSync(baseTexPath, 'utf8');
  const originalSummary = extractSummaryFromTex(texContent);

  let tailoredSummary = originalSummary;
  let highlightedSkills = [];
  let isTailored = false;
  let aiResult = null;

  // Full AI Tailoring with Anti-AI Footprint Guardrails
  if (aiConfig.enabled && jdText && jdText.length > 20) {
    try {
      aiResult = await tailorFullResume({
        title: jobTitle,
        jdText,
        currentSummary: originalSummary,
        category: normCategory,
        cv,
        apiKey,
      });

      if (aiResult && aiResult.summary && aiResult.summary.length > 30) {
        tailoredSummary = aiResult.summary;
        highlightedSkills = aiResult.highlightedSkills || [];
        isTailored = true;
      }
    } catch {
      tailoredSummary = originalSummary;
    }
  }

  const engine = getLatexEngine();
  if (!engine) {
    // No compiler available on system, return static PDF
    return {
      pdfPath: staticPdf,
      s3Key: null,
      s3Url: null,
      texPath: null,
      tailoredSummary,
      isTailored: false,
    };
  }

  try {
    // 1. Replace summary section
    const escapedSummary = escapeLatex(tailoredSummary);
    let updatedTex = texContent.replace(
      /(\\section\{Summary\}\s*(?:\\small\s*)?)([\s\S]*?)(?=\\vspace|\\section)/i,
      `$1${escapedSummary}\n\n`
    );

    // 2. If highlighted skills are found, inject them prominently into skills section
    if (highlightedSkills.length > 0) {
      const skillsStr = highlightedSkills.map(escapeLatex).join(', ');
      updatedTex = updatedTex.replace(
        /(\\item\s*\\textbf\{(?:Core Skills|Programming Languages|Skills)\:\}\s*)([^\n]+)/i,
        `$1${skillsStr}, $2`
      );
    }

    // 3. Replace Work Experience bullets if provided
    if (aiResult && Array.isArray(aiResult.experienceBullets) && aiResult.experienceBullets.length >= 2) {
      const expItems = aiResult.experienceBullets.map(b => `  \\resumeItem{${escapeLatex(b)}}`).join('\n');
      updatedTex = updatedTex.replace(
        /(\\section\{Work Experience\}[\s\S]*?\\resumeItemListStart)([\s\S]*?)(\\resumeItemListEnd)/i,
        `$1\n${expItems}\n$3`
      );
    }

    // 4. Replace Project bullets if provided
    if (aiResult && Array.isArray(aiResult.projectBullets) && aiResult.projectBullets.length >= 2) {
      const projItems = aiResult.projectBullets.map(b => `  \\resumeItem{${escapeLatex(b)}}`).join('\n');
      updatedTex = updatedTex.replace(
        /(\\section\{Projects\}[\s\S]*?\\resumeItemListStart)([\s\S]*?)(\\resumeItemListEnd)/i,
        `$1\n${projItems}\n$3`
      );
    }

    fs.writeFileSync(targetTex, updatedTex, 'utf8');

    // Run LaTeX compiler
    const compileCmd = `${engine} -interaction=nonstopmode -output-directory="${TAILORED_DIR}" "${targetTex}"`;
    execSync(compileCmd, { stdio: 'ignore', timeout: 20000 });

    // Clean up auxiliary files
    const baseName = path.basename(targetTex, '.tex');
    ['.aux', '.log', '.out', '.toc'].forEach(ext => {
      const auxFile = path.join(TAILORED_DIR, `${baseName}${ext}`);
      if (fs.existsSync(auxFile)) {
        try { fs.unlinkSync(auxFile); } catch {}
      }
    });

    if (fs.existsSync(targetPdf) && fs.statSync(targetPdf).size > 1000) {
      // Upload to S3 asynchronously / best effort
      let s3Url = null;
      try {
        await uploadFile(targetPdf, s3Key, 'application/pdf');
        s3Url = await getPresignedDownloadUrl(s3Key);
      } catch {}

      return {
        pdfPath: targetPdf,
        s3Key,
        s3Url,
        texPath: targetTex,
        tailoredSummary,
        isTailored,
      };
    }
  } catch (err) {
    // Fall back to static PDF if compilation fails
  }

  return {
    pdfPath: staticPdf,
    s3Key: null,
    s3Url: null,
    texPath: null,
    tailoredSummary,
    isTailored: false,
  };
}

module.exports = {
  tailorAndCompileResume,
  escapeLatex,
  getLatexEngine,
  STATIC_PDFS,
  TAILORED_DIR,
};
