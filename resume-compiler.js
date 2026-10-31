/**
 * Resume Compiler Module
 * 
 * Dynamically tailors the LaTeX resume Summary, Skills, Work Experience, and Projects per Job Description (JD),
 * compiles the customized LaTeX into a clean, pixel-perfect ATS-friendly 1-page PDF using Tectonic or pdflatex,
 * uploads to Amazon S3, and generates secure pre-signed download URLs.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { tailorFullResume } = require('./gemini-ai');
const { panelCritique, formatPanelInstructions } = require('./hiring-panel-engine');
const { CV, geminiKey, aiConfig } = require('./config');
const { uploadFile, getPresignedDownloadUrl, S3_BUCKET } = require('./s3-storage');

const RESUME_DIR = path.join(__dirname, 'resume');
const TAILORED_DIR = path.join(RESUME_DIR, 'tailored');

const BASE_TEX_FILES = {
  embedded_software: path.join(RESUME_DIR, 'Aditya_Mittha_Embedded_Software.tex'),
  embedded: path.join(RESUME_DIR, 'Aditya_Mittha_Embedded.tex'),
  python_devops: path.join(RESUME_DIR, 'Aditya_Mittha.tex'),
  data_analytics: path.join(RESUME_DIR, 'Aditya_Mittha_Data_Analytics.tex'),
  default: path.join(RESUME_DIR, 'Aditya_Mittha_Embedded_Software.tex'),
};

const STATIC_PDFS = {
  embedded_software: path.join(RESUME_DIR, 'Mittha_Aditya_Embedded_Software.pdf'),
  embedded: path.join(RESUME_DIR, 'Mittha_Aditya_Embedded.pdf'),
  python_devops: path.join(RESUME_DIR, 'Mittha_Aditya.pdf'),
  data_analytics: path.join(RESUME_DIR, 'Mittha_Aditya_Data_Analytics.pdf'),
  default: path.join(RESUME_DIR, 'Mittha_Aditya_Embedded_Software.pdf'),
};

// Ensure tailored directory exists
if (!fs.existsSync(TAILORED_DIR)) {
  fs.mkdirSync(TAILORED_DIR, { recursive: true });
}

/**
 * Escapes common LaTeX special characters in AI-generated text without breaking existing LaTeX commands.
 * @param {string} text 
 * @returns {string}
 */
function escapeLatex(text = '') {
  if (!text) return '';
  let s = String(text).trim();

  // Standardize smart quotes and dashes first
  s = s.replace(/[\u2018\u2019]/g, "'")
       .replace(/[\u201C\u201D]/g, '"')
       .replace(/[\u2013\u2014]/g, '--');

  // Convert paired double quotes to LaTeX style `` ... ''
  s = s.replace(/"([^"]*)"/g, "``$1''");

  // Escape special LaTeX characters only if not already escaped
  s = s.replace(/(?<!\\)&/g, '\\&');
  s = s.replace(/(?<!\\)%/g, '\\%');
  s = s.replace(/(?<!\\)\$/g, '\\$');
  s = s.replace(/(?<!\\)_/g, '\\_');
  s = s.replace(/(?<!\\)#/g, '\\#');

  return s;
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
 * Resolves available LaTeX compiler (bundled Tectonic, system tectonic, pdflatex, or xelatex).
 * @returns {{ type: string, bin: string, compile: (texPath: string, outDir: string) => string }|null}
 */
function resolveLatexEngine() {
  const binDir = path.join(__dirname, 'bin');
  const localTectonicWin = path.join(binDir, 'tectonic.exe');
  const localTectonicLinux = path.join(binDir, 'tectonic');

  // 1. Project-bundled Tectonic (Windows)
  if (process.platform === 'win32' && fs.existsSync(localTectonicWin)) {
    return {
      type: 'tectonic',
      bin: `"${localTectonicWin}"`,
      compile: (texPath, outDir) => `"${localTectonicWin}" "${texPath}" -o "${outDir}"`,
    };
  }

  // 2. Project-bundled Tectonic (Linux)
  if (process.platform !== 'win32' && fs.existsSync(localTectonicLinux)) {
    return {
      type: 'tectonic',
      bin: `"${localTectonicLinux}"`,
      compile: (texPath, outDir) => `"${localTectonicLinux}" "${texPath}" -o "${outDir}"`,
    };
  }

  // 3. System Tectonic
  try {
    const checkCmd = process.platform === 'win32' ? 'where.exe tectonic' : 'which tectonic';
    execSync(checkCmd, { stdio: 'ignore' });
    return {
      type: 'tectonic',
      bin: 'tectonic',
      compile: (texPath, outDir) => `tectonic "${texPath}" -o "${outDir}"`,
    };
  } catch {}

  // 4. System pdflatex
  try {
    const checkCmd = process.platform === 'win32' ? 'where.exe pdflatex' : 'which pdflatex';
    execSync(checkCmd, { stdio: 'ignore' });
    return {
      type: 'pdflatex',
      bin: 'pdflatex',
      compile: (texPath, outDir) => `pdflatex -interaction=nonstopmode -output-directory="${outDir}" "${texPath}"`,
    };
  } catch {}

  // 5. System xelatex
  try {
    const checkCmd = process.platform === 'win32' ? 'where.exe xelatex' : 'which xelatex';
    execSync(checkCmd, { stdio: 'ignore' });
    return {
      type: 'xelatex',
      bin: 'xelatex',
      compile: (texPath, outDir) => `xelatex -interaction=nonstopmode -output-directory="${outDir}" "${texPath}"`,
    };
  } catch {}

  return null;
}

/**
 * Checks if a LaTeX engine is available in system PATH or bundled.
 * @returns {string|null} 'tectonic' | 'pdflatex' | 'xelatex' | null
 */
function getLatexEngine() {
  const resolved = resolveLatexEngine();
  return resolved ? resolved.type : null;
}

/**
 * Replaces the Summary section in the LaTeX resume.
 */
function replaceSummarySection(texContent, tailoredSummary) {
  if (!tailoredSummary || tailoredSummary.trim().length < 20) return texContent;
  const escapedSummary = escapeLatex(tailoredSummary.trim());
  return texContent.replace(
    /(\\section\{Summary\}[\s\S]*?\\small\s*)([\s\S]*?)(\n\s*(?:\\vspace|\\section))/i,
    `$1${escapedSummary}$3`
  );
}

/**
 * Injects prioritized keywords cleanly into the Skills section.
 */
function injectSkillsSection(texContent, highlightedSkills) {
  if (!Array.isArray(highlightedSkills) || highlightedSkills.length === 0) return texContent;
  return texContent.replace(
    /(\\section\{Skills\}[\s\S]*?\\item\s*\\textbf\{[^:}]+\:\}\s*)([^\n]+)/i,
    (match, prefix, existingSkills) => {
      const existingLower = existingSkills.toLowerCase();
      const toAdd = highlightedSkills
        .filter(s => s && typeof s === 'string' && !existingLower.includes(s.toLowerCase().trim()))
        .map(escapeLatex);
      if (toAdd.length === 0) return match;
      const addStr = toAdd.slice(0, 3).join(', ');
      return `${prefix}${addStr}, ${existingSkills}`;
    }
  );
}

/**
 * Replaces bullets in the Work Experience section.
 */
function replaceExperienceSection(texContent, experienceBullets) {
  if (!Array.isArray(experienceBullets) || experienceBullets.length < 2) return texContent;
  const expItems = experienceBullets
    .slice(0, 4)
    .map(b => `  \\resumeItem{${escapeLatex(b.trim())}}`)
    .join('\n');
  return texContent.replace(
    /(\\section\{Work Experience\}[\s\S]*?\\resumeItemListStart)([\s\S]*?)(\\resumeItemListEnd)/i,
    `$1\n${expItems}\n$3`
  );
}

/**
 * Replaces bullets in both Project 1 and Project 2 individually without crossing sections.
 */
function replaceProjectsSection(texContent, p1Bullets, p2Bullets) {
  if ((!p1Bullets || p1Bullets.length === 0) && (!p2Bullets || p2Bullets.length === 0)) {
    return texContent;
  }

  const projSectionIdx = texContent.indexOf('\\section{Projects}');
  if (projSectionIdx === -1) return texContent;

  const beforeProj = texContent.slice(0, projSectionIdx);
  let afterProj = texContent.slice(projSectionIdx);
  const nextSectionMatch = afterProj.slice('\\section{Projects}'.length).match(/\n\\section\{/);
  const nextSectionIdx = nextSectionMatch 
    ? '\\section{Projects}'.length + nextSectionMatch.index 
    : afterProj.length;

  let projBody = afterProj.slice(0, nextSectionIdx);
  const remainingTex = afterProj.slice(nextSectionIdx);

  // Find all \resumeItemListStart ... \resumeItemListEnd inside Projects
  const listPositions = [];
  const startRegex = /\\resumeItemListStart/g;
  let m;
  while ((m = startRegex.exec(projBody)) !== null) {
    const sIdx = m.index;
    const eIdx = projBody.indexOf('\\resumeItemListEnd', sIdx);
    if (eIdx !== -1) {
      listPositions.push({
        contentStart: sIdx + '\\resumeItemListStart'.length,
        end: eIdx,
      });
    }
  }

  // Replace Project 2 first (from back to front to preserve offsets)
  if (listPositions.length >= 2 && Array.isArray(p2Bullets) && p2Bullets.length > 0) {
    const p2Code = p2Bullets.map(b => `  \\resumeItem{${escapeLatex(b.trim())}}`).join('\n');
    projBody = projBody.slice(0, listPositions[1].contentStart) + '\n' + p2Code + '\n' + projBody.slice(listPositions[1].end);
  }

  // Replace Project 1
  if (listPositions.length >= 1 && Array.isArray(p1Bullets) && p1Bullets.length > 0) {
    const p1Code = p1Bullets.map(b => `  \\resumeItem{${escapeLatex(b.trim())}}`).join('\n');
    const p1EndIdx = projBody.indexOf('\\resumeItemListEnd', listPositions[0].contentStart);
    if (p1EndIdx !== -1) {
      projBody = projBody.slice(0, listPositions[0].contentStart) + '\n' + p1Code + '\n' + projBody.slice(p1EndIdx);
    }
  }

  return beforeProj + projBody + remainingTex;
}

/**
 * Tailors LaTeX resume and compiles it to PDF, uploading to S3 if available.
 *
 * @param {object} params
 * @param {string} params.jobId - Unique job identifier or clean title
 * @param {string} params.jobTitle - Job title
 * @param {string} params.jdText - Job description text
 * @param {string} params.category - 'embedded' | 'embedded_software' | 'python_devops' | 'data_analytics'
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
  const normCategory = category === 'embedded_software' ? 'embedded_software' : (category === 'data_analytics' ? 'data_analytics' : (category === 'python_devops' ? 'python_devops' : 'embedded'));
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

  // Full AI Tailoring with Panel-Powered Critique
  if (aiConfig.enabled && jdText && jdText.length > 20) {
    try {
      // Step 1: Run hiring panel critique
      let panelInstructions = '';
      try {
        const panelFindings = await panelCritique({
          resumeText: texContent,
          jobTitle,
          jdText,
          apiKey,
        });
        panelInstructions = formatPanelInstructions(panelFindings);
      } catch {
        // Panel failed — proceed without it
      }

      // Step 2: Tailor resume using panel findings as targeted fix instructions
      aiResult = await tailorFullResume({
        title: jobTitle,
        jdText,
        currentSummary: originalSummary,
        category: normCategory,
        cv,
        apiKey,
        panelInstructions,
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

  const engine = resolveLatexEngine();
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
    let updatedTex = texContent;

    // 1. Replace summary section
    updatedTex = replaceSummarySection(updatedTex, tailoredSummary);

    // 2. Inject highlighted skills cleanly
    updatedTex = injectSkillsSection(updatedTex, highlightedSkills);

    // 3. Replace Work Experience bullets
    if (aiResult && Array.isArray(aiResult.experienceBullets)) {
      updatedTex = replaceExperienceSection(updatedTex, aiResult.experienceBullets);
    }

    // 4. Replace Project bullets for Project 1 and Project 2
    let p1Bullets = aiResult ? (aiResult.project1Bullets || []) : [];
    let p2Bullets = aiResult ? (aiResult.project2Bullets || []) : [];
    if (p1Bullets.length === 0 && p2Bullets.length === 0 && aiResult && Array.isArray(aiResult.projectBullets)) {
      if (aiResult.projectBullets.length >= 4) {
        p1Bullets = aiResult.projectBullets.slice(0, 2);
        p2Bullets = aiResult.projectBullets.slice(2, 4);
      } else if (aiResult.projectBullets.length >= 2) {
        p1Bullets = [aiResult.projectBullets[0]];
        p2Bullets = [aiResult.projectBullets[1]];
      } else if (aiResult.projectBullets.length === 1) {
        p1Bullets = [aiResult.projectBullets[0]];
      }
    }
    updatedTex = replaceProjectsSection(updatedTex, p1Bullets, p2Bullets);

    fs.writeFileSync(targetTex, updatedTex, 'utf8');

    // Run LaTeX compiler command
    const compileCmd = engine.compile(targetTex, TAILORED_DIR);
    execSync(compileCmd, { stdio: 'ignore', timeout: 30000 });

    // Clean up auxiliary files if engine left any
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
  extractSummaryFromTex,
  getLatexEngine,
  resolveLatexEngine,
  BASE_TEX_FILES,
  STATIC_PDFS,
  TAILORED_DIR,
};
