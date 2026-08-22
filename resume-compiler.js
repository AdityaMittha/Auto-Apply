/**
 * Resume Compiler Module
 * 
 * Dynamically tailors the LaTeX resume summary to match specific Job Descriptions (JDs),
 * compiles the customized LaTeX into a clean PDF using pdflatex, and returns the path to the PDF.
 * Falls back gracefully to static base PDFs if LaTeX compilation or AI tailoring is unavailable.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { tailorResumeSummary } = require('./gemini-ai');
const { CV, geminiKey, aiConfig } = require('./config');

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
 * Tailors LaTeX resume and compiles it to PDF.
 *
 * @param {object} params
 * @param {string} params.jobId - Unique job identifier or clean title
 * @param {string} params.jobTitle - Job title
 * @param {string} params.jdText - Job description text
 * @param {string} params.category - 'embedded' | 'python_devops' | 'general'
 * @param {object} [params.cv] - CV profile data
 * @param {string} [params.apiKey] - Gemini API Key
 * @returns {Promise<{ pdfPath: string, texPath: string|null, tailoredSummary: string, isTailored: boolean }>}
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

  // If already compiled for this exact jobId, reuse it
  if (fs.existsSync(targetPdf) && fs.statSync(targetPdf).size > 1000) {
    return {
      pdfPath: targetPdf,
      texPath: fs.existsSync(targetTex) ? targetTex : null,
      tailoredSummary: '(Cached tailored summary)',
      isTailored: true,
    };
  }

  // Verify base .tex exists
  if (!fs.existsSync(baseTexPath)) {
    return {
      pdfPath: staticPdf,
      texPath: null,
      tailoredSummary: '',
      isTailored: false,
    };
  }

  let texContent = fs.readFileSync(baseTexPath, 'utf8');
  const originalSummary = extractSummaryFromTex(texContent);

  let tailoredSummary = originalSummary;
  let isTailored = false;

  // Tailor summary using Gemini AI if enabled
  if (aiConfig.enabled && apiKey && jdText && jdText.length > 30) {
    try {
      const aiSummary = await tailorResumeSummary(jdText, originalSummary, cv, apiKey);
      if (aiSummary && aiSummary.length > 50) {
        tailoredSummary = aiSummary;
        isTailored = true;
      }
    } catch {
      // Fallback to original summary
      tailoredSummary = originalSummary;
    }
  }

  // If not tailored and no compile needed, return static
  const engine = getLatexEngine();
  if (!engine) {
    // No LaTeX compiler on system, return static PDF
    return {
      pdfPath: staticPdf,
      texPath: null,
      tailoredSummary,
      isTailored: false,
    };
  }

  try {
    // Replace summary section in LaTeX template
    const escapedSummary = escapeLatex(tailoredSummary);
    const updatedTex = texContent.replace(
      /(\\section\{Summary\}\s*(?:\\small\s*)?)([\s\S]*?)(?=\\vspace|\\section)/i,
      `$1${escapedSummary}\n\n`
    );

    fs.writeFileSync(targetTex, updatedTex, 'utf8');

    // Run LaTeX compiler
    const compileCmd = `${engine} -interaction=nonstopmode -output-directory="${TAILORED_DIR}" "${targetTex}"`;
    execSync(compileCmd, { stdio: 'ignore', timeout: 20000 });

    // Clean up auxiliary files generated by LaTeX (.aux, .log, .out)
    const baseName = path.basename(targetTex, '.tex');
    ['.aux', '.log', '.out', '.toc'].forEach(ext => {
      const auxFile = path.join(TAILORED_DIR, `${baseName}${ext}`);
      if (fs.existsSync(auxFile)) {
        try { fs.unlinkSync(auxFile); } catch {}
      }
    });

    if (fs.existsSync(targetPdf) && fs.statSync(targetPdf).size > 1000) {
      return {
        pdfPath: targetPdf,
        texPath: targetTex,
        tailoredSummary,
        isTailored,
      };
    }
  } catch (err) {
    // Fall back to static PDF if compilation failed
  }

  return {
    pdfPath: staticPdf,
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
