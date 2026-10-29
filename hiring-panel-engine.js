/**
 * Hiring Panel Engine
 *
 * Implements the 7-reviewer hiring panel from the hiring-panel skill
 * (alexyc9381/hiring-panel-skill) using Gemini AI.
 *
 * Model strategy:
 *   - Panel reviewers  → gemini-4-argon   (frontier reasoning, deep critique, ~15% hallucination rate)
 *   - Fallback         → gemini-3.8-flash  (long-horizon agent, 1M context, if Argon quota exhausted)
 *
 * Each reviewer is a separate Gemini call with a distinct persona —
 * they never see each other's notes. Results are merged into a ranked
 * list of issues that drive targeted resume tailoring.
 *
 * Usage:
 *   const { panelCritique } = require('./hiring-panel-engine');
 *   const findings = await panelCritique({ resumeText, jobTitle, jdText, apiKey });
 *   // findings.missingKeywords, findings.rankedIssues, findings.screenVerdict
 */

const { callGemini } = require('./gemini-ai');

// ─── Reviewer Personas ────────────────────────────────────────────────────────

const REVIEWERS = {
  automatedScreen: {
    name: 'Automated Screen',
    prompt: (resumeText, jdText) => `You are an ATS (Applicant Tracking System) deciding if a human recruiter should see this resume.

RESUME:
${resumeText}

JOB DESCRIPTION:
${jdText}

Check in this exact order:
1. Can the text be parsed top to bottom? (columns, tables, encoding issues)
2. Are job titles, employers, and dates clearly formatted?
3. Which key skills/terms from the JD appear in the resume, and which are missing?
4. Contact details present, length sensible, no filler?

Respond ONLY in this JSON format:
{
  "verdict": "PASS" or "REJECT",
  "reasons": ["<quoted line or issue 1>", "<quoted line or issue 2>"],
  "missingKeywords": ["<keyword from JD missing in resume>"],
  "presentKeywords": ["<keyword from JD that IS in resume>"]
}`,
  },

  hiringManager: {
    name: 'Hiring Manager',
    prompt: (resumeText, jdText) => `You are the hiring manager deciding if this person gets an interview for this role.

RESUME:
${resumeText}

JOB DESCRIPTION:
${jdText}

What decided it in the first 10 seconds? What would you ask in the interview? What are the 3 weakest lines?

Respond ONLY in this JSON format:
{
  "verdict": "INTERVIEW" or "NO",
  "decidingFactor": "<what decided it in 10 seconds>",
  "weakestLines": ["<quoted weak line 1>", "<quoted weak line 2>", "<quoted weak line 3>"],
  "interviewQuestions": ["<question 1>", "<question 2>"],
  "topIssue": "<the single most damaging problem>"
}`,
  },

  readerHiringManager: {
    name: 'Reader: Hiring Manager',
    prompt: (resumeText, jdText) => `You are a hiring manager reading this resume for ONE thing: can this person do the job on day one?

RESUME:
${resumeText}

JOB DESCRIPTION (for context):
${jdText}

Answer in under 120 words. Be blunt. No flattery.

Respond ONLY in this JSON format:
{
  "verdict": "HIRE" or "MAYBE" or "PASS",
  "hurtMost": "<the single quoted line that hurt most>",
  "problem2": "<second problem>",
  "problem3": "<third problem>"
}`,
  },

  readerRivalApplicant: {
    name: 'Reader: Rival Applicant',
    prompt: (resumeText, jdText) => `You are another applicant who applied for the same role. Read this resume as a rival — where is it weaker than yours?

RESUME:
${resumeText}

JOB DESCRIPTION (the role you both applied to):
${jdText}

Answer in under 120 words. Be competitive and honest.

Respond ONLY in this JSON format:
{
  "verdict": "HIRE" or "MAYBE" or "PASS",
  "hurtMost": "<the single quoted line that hurt most vs. a strong rival>",
  "problem2": "<where your resume is stronger — concrete skill or experience>",
  "problem3": "<another weakness vs. a strong rival>"
}`,
  },

  readerCEO: {
    name: 'Reader: CEO',
    prompt: (resumeText, _jdText) => `You are a CEO reading resumes. You read for impact: what did this person actually change, and by how much?

RESUME:
${resumeText}

Answer in under 120 words. You want outcomes, not responsibilities.

Respond ONLY in this JSON format:
{
  "verdict": "HIRE" or "MAYBE" or "PASS",
  "hurtMost": "<the single quoted line with no measurable outcome>",
  "problem2": "<another place impact is missing or vague>",
  "problem3": "<structural issue — e.g., no metrics, no before/after>"
}`,
  },

  readerRecruiter: {
    name: 'Reader: Recruiter',
    prompt: (resumeText, _jdText) => `You are a recruiter with 30 seconds and 100 resumes. You read only the top third.

RESUME:
${resumeText}

You only read the Summary and Skills. Make a snap judgment.

Respond ONLY in this JSON format:
{
  "verdict": "HIRE" or "MAYBE" or "PASS",
  "hurtMost": "<the single quoted line in the top third that hurt most>",
  "problem2": "<what's missing or confusing in the top third>",
  "problem3": "<formatting or clarity issue that slows the 30-second scan>"
}`,
  },

  readerTeammate: {
    name: 'Reader: Teammate',
    prompt: (resumeText, _jdText) => `You are someone who would work next to this person. You read for how they work with others.

RESUME:
${resumeText}

Answer in under 120 words. You want signals of collaboration, not solo heroics.

Respond ONLY in this JSON format:
{
  "verdict": "HIRE" or "MAYBE" or "PASS",
  "hurtMost": "<the single quoted line showing lack of team collaboration signal>",
  "problem2": "<what team-working evidence is missing>",
  "problem3": "<any red flag for team dynamics>"
}`,
  },
};

// ─── Individual Reviewer Call ─────────────────────────────────────────────────

// Model preference for panel reviewers
// gemini-3.8-flash → primary (long-horizon agent, 1M context, best reasoning without free-tier block)
// gemini-3.6-flash → fast fallback with guaranteed uptime
const PANEL_MODEL_PRIMARY  = process.env.PANEL_MODEL || 'gemini-3.8-flash';
const PANEL_MODEL_FALLBACK = 'gemini-3.6-flash';

/**
 * Runs a single reviewer against the resume and JD.
 * Tries gemini-2.5-pro first; falls back to gemini-2.5-flash on quota/error.
 * @param {string} reviewerKey - Key in REVIEWERS
 * @param {string} resumeText
 * @param {string} jdText
 * @param {string} apiKey
 * @returns {Promise<object>} Parsed JSON verdict or null
 */
async function runReviewer(reviewerKey, resumeText, jdText, apiKey) {
  const reviewer = REVIEWERS[reviewerKey];
  if (!reviewer) return null;

  const prompt = reviewer.prompt(
    resumeText.slice(0, 3000),
    jdText.slice(0, 2000)
  );

  // Helper to parse JSON from raw text
  function parseResult(raw) {
    if (!raw) return null;
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    try { return JSON.parse(cleaned); } catch {}
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) { try { return JSON.parse(match[0]); } catch {} }
    return null;
  }

  try {
    // Attempt with gemini-2.5-pro first
    let raw = await callGemini(prompt, apiKey, {
      maxTokens: 1024,
      temperature: 0.1,
      model: PANEL_MODEL_PRIMARY,
    });

    // If pro returned null (quota / not available), fall back to flash
    if (!raw) {
      raw = await callGemini(prompt, apiKey, {
        maxTokens: 1024,
        temperature: 0.1,
        model: PANEL_MODEL_FALLBACK,
      });
    }
    if (!raw) return null;
    return parseResult(raw);
  } catch {
    return null;
  }
}

// ─── Panel Merger ─────────────────────────────────────────────────────────────

/**
 * Merges all 7 reviewer results into a ranked findings object.
 * @param {object} results - Map of reviewerKey → result
 * @returns {object} { screenVerdict, rankedIssues[], missingKeywords[], verdicts{} }
 */
function mergeFindings(results) {
  const issues = new Map(); // issue text → { count, reviewers[] }
  const missingKeywords = new Set();
  const verdicts = {};

  const recordIssue = (text, reviewer) => {
    if (!text || text.length < 5) return;
    const key = text.slice(0, 80).toLowerCase();
    if (!issues.has(key)) issues.set(key, { text, count: 0, reviewers: [] });
    const entry = issues.get(key);
    entry.count++;
    if (!entry.reviewers.includes(reviewer)) entry.reviewers.push(reviewer);
  };

  // Automated Screen
  const screen = results.automatedScreen;
  if (screen) {
    verdicts.screen = screen.verdict || 'UNKNOWN';
    (screen.reasons || []).forEach(r => recordIssue(r, 'Automated Screen'));
    (screen.missingKeywords || []).forEach(kw => missingKeywords.add(kw));
  }

  // Hiring Manager
  const hm = results.hiringManager;
  if (hm) {
    verdicts.hiringManager = hm.verdict || 'UNKNOWN';
    (hm.weakestLines || []).forEach(l => recordIssue(l, 'Hiring Manager'));
    if (hm.topIssue) recordIssue(hm.topIssue, 'Hiring Manager');
  }

  // Five solo readers
  const readerKeys = ['readerHiringManager', 'readerRivalApplicant', 'readerCEO', 'readerRecruiter', 'readerTeammate'];
  const readerNames = { readerHiringManager: 'Reader: Hiring Mgr', readerRivalApplicant: 'Reader: Rival', readerCEO: 'Reader: CEO', readerRecruiter: 'Reader: Recruiter', readerTeammate: 'Reader: Teammate' };

  for (const key of readerKeys) {
    const r = results[key];
    if (!r) continue;
    verdicts[key] = r.verdict || 'UNKNOWN';
    if (r.hurtMost) recordIssue(r.hurtMost, readerNames[key]);
    if (r.problem2) recordIssue(r.problem2, readerNames[key]);
    if (r.problem3) recordIssue(r.problem3, readerNames[key]);
  }

  // Sort issues by how many reviewers flagged them (worst first)
  const rankedIssues = Array.from(issues.values())
    .sort((a, b) => b.count - a.count || b.text.length - a.text.length)
    .slice(0, 10)
    .map((issue, i) => ({
      rank: i + 1,
      issue: issue.text,
      flaggedBy: issue.reviewers,
      flagCount: issue.count,
    }));

  return {
    screenVerdict: screen?.verdict || 'UNKNOWN',
    missingKeywords: Array.from(missingKeywords),
    rankedIssues,
    verdicts,
    rawResults: results,
  };
}

// ─── Main Panel Function ──────────────────────────────────────────────────────

/**
 * Runs the full 7-reviewer hiring panel concurrently.
 *
 * @param {object} params
 * @param {string} params.resumeText - Plain text of the resume
 * @param {string} params.jobTitle   - Job title string
 * @param {string} params.jdText     - Full job description text
 * @param {string} params.apiKey     - Gemini API key
 * @returns {Promise<object>} Panel findings: { screenVerdict, missingKeywords, rankedIssues, verdicts }
 */
async function panelCritique({ resumeText = '', jobTitle = '', jdText = '', apiKey = '' }) {
  if (!apiKey || !resumeText || !jdText) {
    return {
      screenVerdict: 'UNKNOWN',
      missingKeywords: [],
      rankedIssues: [],
      verdicts: {},
      rawResults: {},
    };
  }

  const jdWithTitle = `Role: ${jobTitle}\n\n${jdText}`;

  // Run all 7 reviewers concurrently — none see each other's results
  const [
    automatedScreen,
    hiringManager,
    readerHiringManager,
    readerRivalApplicant,
    readerCEO,
    readerRecruiter,
    readerTeammate,
  ] = await Promise.all([
    runReviewer('automatedScreen', resumeText, jdWithTitle, apiKey),
    runReviewer('hiringManager', resumeText, jdWithTitle, apiKey),
    runReviewer('readerHiringManager', resumeText, jdWithTitle, apiKey),
    runReviewer('readerRivalApplicant', resumeText, jdWithTitle, apiKey),
    runReviewer('readerCEO', resumeText, jdWithTitle, apiKey),
    runReviewer('readerRecruiter', resumeText, jdWithTitle, apiKey),
    runReviewer('readerTeammate', resumeText, jdWithTitle, apiKey),
  ]);

  const results = {
    automatedScreen,
    hiringManager,
    readerHiringManager,
    readerRivalApplicant,
    readerCEO,
    readerRecruiter,
    readerTeammate,
  };

  return mergeFindings(results);
}

/**
 * Formats panel findings into a concise instruction block for the tailoring prompt.
 * Tells Gemini exactly what problems to fix in the tailored resume.
 *
 * @param {object} findings - Output of panelCritique()
 * @returns {string} Formatted instructions
 */
function formatPanelInstructions(findings) {
  if (!findings || !findings.rankedIssues || findings.rankedIssues.length === 0) {
    return '';
  }

  const lines = [
    '=== HIRING PANEL CRITIQUE (fix these in the tailored resume) ===',
    '',
    `ATS Screen: ${findings.screenVerdict}`,
    '',
  ];

  if (findings.missingKeywords.length > 0) {
    lines.push(`MISSING KEYWORDS (must inject naturally): ${findings.missingKeywords.slice(0, 8).join(', ')}`);
    lines.push('');
  }

  lines.push('RANKED ISSUES (worst first):');
  for (const item of findings.rankedIssues.slice(0, 7)) {
    lines.push(`${item.rank}. [${item.flaggedBy.join(', ')}] ${item.issue}`);
  }

  lines.push('');
  lines.push('FIX EVERY ISSUE ABOVE in the tailored resume. Do not invent new facts.');
  lines.push('=== END PANEL CRITIQUE ===');

  return lines.join('\n');
}

module.exports = {
  panelCritique,
  formatPanelInstructions,
  runReviewer,
  mergeFindings,
  REVIEWERS,
};
