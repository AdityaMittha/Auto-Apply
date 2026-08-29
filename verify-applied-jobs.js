/**
 * Live Job Application Verification Engine
 * 
 * Verifies whether jobs in `applied-jobs.json` were successfully submitted
 * by navigating to each job's live website / URL and inspecting the actual
 * application state on the platform.
 * 
 * Key Features (Zero Hardcoding):
 *  1. Dynamic Multi-Layer Semantic Inspection: Evaluates buttons, status tags,
 *     badges, alert banners, disabled CTA states, and surrounding text.
 *  2. Multi-Portal Session Awareness: Automatically mounts the right Chrome profile
 *     (Naukri, Internshala, LinkedIn, Indeed, Foundit, Wellfound, or Career Page ATS).
 *  3. Adaptive AI Fallback: Uses Gemini Flash to semantically reason over DOM excerpts
 *     when custom ATS layouts or non-standard confirmation patterns appear.
 *  4. Post-Apply Live Hook: Can be called immediately after submitting an application
 *     in any apply engine to confirm state transition before recording the application.
 *  5. Standalone Audit Runner: Can audit all pending or existing applications in batch.
 * 
 * Usage:
 *   node verify-applied-jobs.js                  # Audit recent applications
 *   node verify-applied-jobs.js visible          # Audit with visible Chrome browser
 *   node verify-applied-jobs.js --today          # Audit applications from today
 *   node verify-applied-jobs.js --portal=Naukri  # Filter by specific portal
 *   node verify-applied-jobs.js --jobId=123456   # Verify a specific single job
 *   node verify-applied-jobs.js --all            # Audit entire application database
 *   node verify-applied-jobs.js --limit=20       # Limit maximum jobs to verify
 */

const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { CV, geminiKey } = require('./config');
const { callGemini } = require('./gemini-ai');

const APPLIED_FILE = path.join(__dirname, 'applied-jobs.json');
const LOG_FILE = path.join(__dirname, 'naukri-applications.log');

const log = (msg) => {
  const line = `[${new Date().toLocaleString()}] [VERIFIER] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {}
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadAppliedJobs() {
  try {
    if (fs.existsSync(APPLIED_FILE)) {
      return JSON.parse(fs.readFileSync(APPLIED_FILE, 'utf8'));
    }
  } catch (e) {}
  return { applied: [], lastUpdated: null };
}

function saveAppliedJobs(data) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(APPLIED_FILE, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Maps a portal name to its local persistent profile directory.
 * @param {string} portal
 * @returns {string} Absolute path to chrome profile directory
 */
function getProfileDirForPortal(portal = '') {
  const p = (portal || '').toLowerCase();
  if (p.includes('internshala')) return path.join(__dirname, '.internshala-chrome-profile');
  if (p.includes('linkedin')) return path.join(__dirname, '.linkedin-chrome-profile');
  if (p.includes('indeed')) return path.join(__dirname, '.indeed-chrome-profile');
  if (p.includes('foundit') || p.includes('monster')) return path.join(__dirname, '.foundit-chrome-profile');
  if (p.includes('wellfound') || p.includes('angel')) return path.join(__dirname, '.wellfound-chrome-profile');
  return path.join(__dirname, '.naukri-chrome-profile');
}

/**
 * Analyzes the DOM of an open page dynamically without relying on brittle single selectors.
 * Extracts CTAs, status badges, alert banners, and surrounding text to evaluate application state.
 * @param {import('playwright-core').Page} page
 * @param {object} job
 * @returns {Promise<object>} Verification result
 */
async function inspectPageForAppliedStatus(page, job) {
  try {
    // Wait for content or any dynamic SPA components to settle
    await page.waitForTimeout(2500);

    const evaluation = await page.evaluate((jobMeta) => {
      // 1. Gather all clickable buttons and action links
      const buttons = Array.from(document.querySelectorAll('button, a[role="button"], a.btn, input[type="submit"], input[type="button"], [class*="apply"], [class*="btn"], [class*="button"]'));
      
      const buttonInfo = buttons.map(b => {
        const text = (b.innerText || b.textContent || b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();
        const isDisabled = b.disabled || b.getAttribute('aria-disabled') === 'true' || b.classList.contains('disabled');
        const className = b.className || '';
        const id = b.id || '';
        return { text, isDisabled, className, id };
      }).filter(b => b.text.length > 0 && b.text.length < 80);

      // 2. Gather status indicators, badges, and alerts
      const statusEls = Array.from(document.querySelectorAll('[role="alert"], [class*="alert"], [class*="status"], [class*="badge"], [class*="applied"], [class*="tag"], [class*="banner"], [class*="notice"], [class*="feedback"], [data-testid*="applied"], [data-applied]'));
      
      const statusTexts = statusEls.map(el => (el.innerText || el.textContent || '').trim())
        .filter(t => t.length > 0 && t.length < 200);

      // 3. Check page title and main text summary
      const bodyText = (document.body ? document.body.innerText : '').slice(0, 15000);
      const currentUrl = window.location.href;

      // Positive "Applied" patterns (broad & dynamic)
      const appliedPatterns = [
        /already\s+applied/i,
        /applied\s+on\b/i,
        /you\s+applied\b/i,
        /you\s+have\s+already\s+applied/i,
        /application\s+(?:submitted|received|sent|under\s+review|in\s+progress)/i,
        /applied\s+(?:successfully|earlier|recently|\d+\s*(?:day|days|hour|hours|week|weeks|month|months)\s*ago)/i,
        /view\s+application\s+status/i,
        /manage\s+application/i,
        /withdrawn?\s+application/i,
      ];

      // Unapplied / Active Apply patterns
      const unappliedPatterns = [
        /^apply\s+now$/i,
        /^easy\s+apply$/i,
        /^quick\s+apply$/i,
        /^apply\s+on\s+company\s+site$/i,
        /^apply\s+externally$/i,
        /^i\s+am\s+interested$/i,
        /^apply\s+with\b/i,
        /^start\s+application$/i,
      ];

      // Job Expired / Closed patterns
      const expiredPatterns = [
        /this\s+job\s+has\s+expired/i,
        /job\s+is\s+closed/i,
        /no\s+longer\s+accepting\s+applications/i,
        /job\s+posting\s+has\s+expired/i,
        /this\s+position\s+has\s+been\s+filled/i,
        /job\s+is\s+no\s+longer\s+available/i,
      ];

      let isApplied = false;
      let isUnapplied = false;
      let isExpired = false;
      let matchedEvidence = [];
      let currentStatusText = '';

      // Check Buttons
      for (const btn of buttonInfo) {
        for (const p of appliedPatterns) {
          if (p.test(btn.text)) {
            isApplied = true;
            matchedEvidence.push(`Button '${btn.text}' matches applied pattern`);
            currentStatusText = btn.text;
            break;
          }
        }

        // A disabled button stating just "Applied"
        if (/^applied$/i.test(btn.text)) {
          isApplied = true;
          matchedEvidence.push(`Button text is 'Applied' (disabled: ${btn.isDisabled})`);
          currentStatusText = 'Applied';
        }

        for (const p of unappliedPatterns) {
          if (p.test(btn.text)) {
            isUnapplied = true;
            matchedEvidence.push(`Button '${btn.text}' matches active unapplied CTA`);
            break;
          }
        }
      }

      // Check Status Elements
      for (const st of statusTexts) {
        for (const p of appliedPatterns) {
          if (p.test(st)) {
            isApplied = true;
            matchedEvidence.push(`Status banner text: "${st.slice(0, 80)}"`);
            if (!currentStatusText) currentStatusText = st.slice(0, 50);
            break;
          }
        }
      }

      // Check Expired patterns
      for (const p of expiredPatterns) {
        if (p.test(bodyText)) {
          isExpired = true;
          matchedEvidence.push(`Page matches expired job pattern: ${p.source}`);
          break;
        }
      }

      return {
        isApplied,
        isUnapplied,
        isExpired,
        currentUrl,
        matchedEvidence,
        currentStatusText,
        buttonSamples: buttonInfo.slice(0, 10),
        statusSamples: statusTexts.slice(0, 10),
        bodySnippet: bodyText.slice(0, 1500),
      };
    }, { title: job.title, company: job.company });

    // Deduce final heuristic verdict
    if (evaluation.isApplied && !evaluation.isUnapplied) {
      return {
        verified: true,
        verificationStatus: 'VERIFIED_APPLIED',
        confidence: 0.95,
        details: evaluation.matchedEvidence.join(' | ') || 'Confirmed applied on job listing',
        statusText: evaluation.currentStatusText || 'Applied',
        method: 'LIVE_PAGE_DOM',
      };
    }

    if (evaluation.isExpired) {
      return {
        verified: false,
        verificationStatus: 'JOB_CLOSED',
        confidence: 0.90,
        details: evaluation.matchedEvidence.join(' | ') || 'Job is closed or expired',
        statusText: 'CLOSED',
        method: 'LIVE_PAGE_DOM',
      };
    }

    if (evaluation.isUnapplied && !evaluation.isApplied) {
      return {
        verified: false,
        verificationStatus: 'NOT_APPLIED',
        confidence: 0.85,
        details: evaluation.matchedEvidence.join(' | ') || 'Active Apply button found on page',
        statusText: 'Not Applied',
        method: 'LIVE_PAGE_DOM',
      };
    }

    // If ambiguous (both applied and unapplied signals or neither), invoke adaptive AI fallback
    if (geminiKey) {
      const aiVerdict = await verifyWithGeminiAI(job, evaluation, geminiKey);
      if (aiVerdict) {
        return aiVerdict;
      }
    }

    return {
      verified: evaluation.isApplied,
      verificationStatus: evaluation.isApplied ? 'VERIFIED_APPLIED' : (evaluation.isUnapplied ? 'NOT_APPLIED' : 'UNVERIFIED_UNCERTAIN'),
      confidence: 0.60,
      details: evaluation.matchedEvidence.join(' | ') || 'Ambiguous DOM indicators',
      statusText: evaluation.currentStatusText || 'Unknown',
      method: 'DOM_HEURISTICS_UNCERTAIN',
    };

  } catch (err) {
    return {
      verified: false,
      verificationStatus: 'ERROR_CHECKING',
      confidence: 0,
      details: `Page inspection failed: ${err.message}`,
      statusText: 'Error',
      method: 'FAILED',
    };
  }
}

/**
 * Adaptive AI Fallback: Uses Gemini AI to semantically reason over extracted DOM elements
 * when custom ATS portals or non-standard page structures are encountered.
 * @param {object} job
 * @param {object} evaluation
 * @param {string} apiKey
 * @returns {Promise<object|null>}
 */
async function verifyWithGeminiAI(job, evaluation, apiKey) {
  try {
    const prompt = `You are an automated QA bot verifying if a candidate has already applied to a job.
Analyze the following live page excerpt for "${job.title}" at "${job.company}".

URL: ${evaluation.currentUrl}
Interactive Buttons Found:
${JSON.stringify(evaluation.buttonSamples, null, 2)}

Status & Alert Elements:
${JSON.stringify(evaluation.statusSamples, null, 2)}

Page Body Excerpt:
${evaluation.bodySnippet}

Based strictly on this data, has the user already applied to this position on this website?
Respond in strict JSON with:
{
  "isApplied": true | false | null,
  "status": "VERIFIED_APPLIED" | "NOT_APPLIED" | "JOB_CLOSED" | "UNKNOWN",
  "confidence": 0.0 to 1.0,
  "reasoning": "Brief one sentence explanation of the evidence found"
}`;

    const raw = await callGemini(prompt, apiKey, {
      maxTokens: 500,
      temperature: 0.1,
      timeoutMs: 12000,
    });

    if (!raw) return null;

    const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    return {
      verified: parsed.isApplied === true,
      verificationStatus: parsed.status || (parsed.isApplied ? 'VERIFIED_APPLIED' : 'NOT_APPLIED'),
      confidence: parsed.confidence || 0.85,
      details: `AI Verified: ${parsed.reasoning || 'Semantic DOM analysis'}`,
      statusText: parsed.isApplied ? 'Applied' : (parsed.status === 'JOB_CLOSED' ? 'Closed' : 'Not Applied'),
      method: 'AI_SEMANTIC_DOM',
    };
  } catch (e) {
    return null;
  }
}

/**
 * Cross-checks applications against the portal's dedicated user history dashboard.
 * @param {string} portal
 * @param {import('playwright-core').BrowserContext} ctx
 * @returns {Promise<Array<object>>}
 */
async function fetchPortalDashboardApplications(portal, ctx) {
  const p = (portal || '').toLowerCase();
  const page = ctx.pages()[0] || (await ctx.newPage());
  const results = [];

  try {
    if (p.includes('naukri')) {
      await page.goto('https://www.naukri.com/mnjuser/applications', { waitUntil: 'domcontentloaded', timeout: 35000 });
      await page.waitForTimeout(3000);
      const rows = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.app-history-row, .app-card, [class*="application-card"], [class*="job-tuple"], .tuple'));
        return items.map(el => {
          const title = (el.querySelector('.title, .designation, a[class*="title"]') || {}).innerText || '';
          const company = (el.querySelector('.company, .org, a[class*="comp-name"]') || {}).innerText || '';
          const status = (el.querySelector('.status, .app-status, [class*="status"]') || {}).innerText || 'Applied';
          const appliedDate = (el.querySelector('.applied-date, [class*="date"], .time-stamp') || {}).innerText || '';
          return { title: title.trim(), company: company.trim(), status: status.trim(), appliedDate: appliedDate.trim() };
        }).filter(r => r.title || r.company);
      });
      return rows;
    }

    if (p.includes('internshala')) {
      await page.goto('https://internshala.com/student/applications', { waitUntil: 'domcontentloaded', timeout: 35000 });
      await page.waitForTimeout(3000);
      const rows = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('#applications_table tbody tr, .application_row, .table-row'));
        return items.map(el => {
          const title = (el.querySelector('.profile_name, td.profile, a.view_detail_button') || {}).innerText || '';
          const company = (el.querySelector('.company_name, td.company') || {}).innerText || '';
          const status = (el.querySelector('.status, .application_status, td.status') || {}).innerText || 'Applied';
          const appliedDate = (el.querySelector('.applied_on, td.applied_on') || {}).innerText || '';
          return { title: title.trim(), company: company.trim(), status: status.trim(), appliedDate: appliedDate.trim() };
        }).filter(r => r.title || r.company);
      });
      return rows;
    }

    if (p.includes('linkedin')) {
      await page.goto('https://www.linkedin.com/my-items/saved-jobs/?cardType=APPLIED', { waitUntil: 'domcontentloaded', timeout: 35000 });
      await page.waitForTimeout(3000);
      const rows = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.reusable-search__result-container, .job-card-container, [data-view-name*="job-card"]'));
        return items.map(el => {
          const title = (el.querySelector('.job-card-list__title, a[class*="title"]') || {}).innerText || '';
          const company = (el.querySelector('.job-card-container__company-name, [class*="subtitle"]') || {}).innerText || '';
          const status = (el.querySelector('.job-card-container__footer-job-state, [class*="state"]') || {}).innerText || 'Applied';
          return { title: title.trim(), company: company.trim(), status: status.trim() };
        }).filter(r => r.title || r.company);
      });
      return rows;
    }
  } catch (err) {
    log(`⚠️ Could not fetch ${portal} dashboard applications: ${err.message}`);
  }

  return results;
}

/**
 * Verifies a single job by navigating directly to its destination URL.
 * @param {object} job - Job record from applied-jobs.json
 * @param {import('playwright-core').BrowserContext} ctx - Active Playwright persistent context
 * @returns {Promise<object>} Verification report
 */
async function verifyJobOnLiveSite(job, ctx) {
  const targetUrl = job.externalUrl || job.url;
  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    return {
      jobId: job.jobId,
      title: job.title,
      company: job.company,
      verified: false,
      verificationStatus: 'INVALID_URL',
      details: 'Job has no valid URL to inspect',
      statusText: 'No URL',
      method: 'NONE',
    };
  }

  const page = await ctx.newPage();
  try {
    log(`🔎 Inspecting: ${job.title} at ${job.company} (${job.portal || 'Direct'})`);
    log(`   URL: ${targetUrl}`);

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    
    // Inspect DOM signals
    const inspection = await inspectPageForAppliedStatus(page, job);
    log(`   🎯 Result: [${inspection.verificationStatus}] (${Math.round(inspection.confidence * 100)}% confidence) - ${inspection.details}`);

    return {
      jobId: job.jobId,
      title: job.title,
      company: job.company,
      portal: job.portal,
      url: targetUrl,
      verified: inspection.verified,
      verificationStatus: inspection.verificationStatus,
      confidence: inspection.confidence,
      details: inspection.details,
      statusText: inspection.statusText,
      method: inspection.method,
      verifiedAt: new Date().toISOString(),
    };
  } catch (err) {
    log(`   ❌ Error verifying job: ${err.message}`);
    return {
      jobId: job.jobId,
      title: job.title,
      company: job.company,
      verified: false,
      verificationStatus: 'NAVIGATION_FAILED',
      details: err.message,
      statusText: 'Error',
      method: 'FAILED',
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Public Hook: Can be called immediately after submitting an application inside any apply script.
 * @param {import('playwright-core').Page} page - Existing page after clicking submit
 * @param {object} job - Job metadata
 * @returns {Promise<object>}
 */
async function verifyPostSubmission(page, job) {
  log(`🛡️ Running post-submission live verification for ${job.title} at ${job.company}...`);
  await page.waitForTimeout(3500);
  const result = await inspectPageForAppliedStatus(page, job);
  log(`   Post-apply verdict: [${result.verificationStatus}] - ${result.details}`);
  return result;
}

/**
 * Main Verification Suite: Audits jobs in applied-jobs.json against live websites.
 */
async function runVerificationSuite(options = {}) {
  const {
    portalFilter = null,
    jobIdFilter = null,
    todayOnly = false,
    allJobs = false,
    limit = 50,
    visible = false,
    dryRun = false,
  } = options;

  log(`=======================================================`);
  log(`🔍 Starting Live Job Application Verification Engine`);
  log(`⚙️ Options: Portal=${portalFilter || 'ALL'} | TodayOnly=${todayOnly} | Limit=${limit} | Visible=${visible}`);
  log(`=======================================================`);

  const db = loadAppliedJobs();
  if (!db.applied || db.applied.length === 0) {
    log(`ℹ️ No applications found in applied-jobs.json to verify.`);
    return { total: 0, verifiedCount: 0, failedCount: 0 };
  }

  // Filter target jobs
  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  let candidateJobs = db.applied.filter(j => {
    if (jobIdFilter && String(j.jobId) !== String(jobIdFilter)) return false;
    if (portalFilter && !(j.portal || '').toLowerCase().includes(portalFilter.toLowerCase())) return false;
    if (todayOnly) {
      const jDate = j.appliedAt ? new Date(j.appliedAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : '';
      if (jDate !== todayIST) return false;
    }
    if (!allJobs && (j.status === 'PREVIEW_DRY_RUN' || j.verificationStatus === 'VERIFIED_APPLIED')) {
      // By default skip dry runs or already verified jobs unless --all is specified
      if (!allJobs) return false;
    }
    return true;
  });

  // Default to recent applied jobs if all were filtered out
  if (candidateJobs.length === 0 && !jobIdFilter && !portalFilter && !todayOnly) {
    log(`ℹ️ All applications were already verified or dry runs. Checking the most recent ${limit} submitted applications...`);
    candidateJobs = db.applied
      .filter(j => j.status === 'APPLIED' || j.status === 'EXTERNAL_REDIRECT' || j.status === 'PENDING_VERIFICATION')
      .slice(-limit);
  }

  candidateJobs = candidateJobs.slice(-limit);
  log(`📋 Found ${candidateJobs.length} job application(s) queued for live verification.`);

  if (candidateJobs.length === 0) {
    log(`✅ Nothing to verify.`);
    return { total: 0, verifiedCount: 0, failedCount: 0 };
  }

  // Group candidate jobs by portal to reuse persistent Chrome sessions
  const jobsByPortal = {};
  for (const job of candidateJobs) {
    const p = job.portal ? job.portal.split(' ')[0] : 'Naukri';
    if (!jobsByPortal[p]) jobsByPortal[p] = [];
    jobsByPortal[p].push(job);
  }

  const IS_LINUX = process.platform === 'linux';
  const report = [];
  let verifiedCount = 0;
  let notAppliedCount = 0;
  let errorCount = 0;

  for (const [portalName, jobs] of Object.entries(jobsByPortal)) {
    const profileDir = getProfileDirForPortal(portalName);
    log(`\n🌐 Launching session for [${portalName}] (${jobs.length} jobs to verify)...`);

    let ctx = null;
    try {
      ctx = await chromium.launchPersistentContext(profileDir, {
        channel: IS_LINUX ? 'chromium' : 'chrome',
        headless: false,
        viewport: { width: 1280, height: 850 },
        args: [
          '--disable-blink-features=AutomationControlled',
          ...(IS_LINUX ? ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] : []),
          ...(visible ? [] : ['--window-position=-32000,-32000']),
        ],
      });

      // Optional: Pre-fetch portal dashboard history to enrich verification
      const dashboardHistory = await fetchPortalDashboardApplications(portalName, ctx);
      if (dashboardHistory.length > 0) {
        log(`   📊 Found ${dashboardHistory.length} application records in ${portalName} portal dashboard history.`);
      }

      for (const job of jobs) {
        // Step 1: Direct Job Page Inspection
        const res = await verifyJobOnLiveSite(job, ctx);

        // Step 2: Cross-check with Dashboard History if ambiguous
        if (res.verificationStatus !== 'VERIFIED_APPLIED' && dashboardHistory.length > 0) {
          const dashMatch = dashboardHistory.find(dh => 
            (dh.company && job.company && job.company.toLowerCase().includes(dh.company.toLowerCase())) ||
            (dh.title && job.title && job.title.toLowerCase().includes(dh.title.toLowerCase()))
          );
          if (dashMatch) {
            log(`   💡 Cross-matched with portal dashboard history: Status = "${dashMatch.status}"`);
            res.verified = true;
            res.verificationStatus = 'VERIFIED_APPLIED';
            res.details = `Verified via ${portalName} Dashboard: Status="${dashMatch.status}" (Applied: ${dashMatch.appliedDate || 'Yes'})`;
            res.method = 'PORTAL_DASHBOARD';
            res.statusText = dashMatch.status;
          }
        }

        // Update DB record
        const record = db.applied.find(a => (a.jobId && a.jobId === job.jobId) || (a.url && a.url === job.url));
        if (record) {
          record.verified = res.verified;
          record.verificationStatus = res.verificationStatus;
          record.verifiedAt = res.verifiedAt || new Date().toISOString();
          record.verificationMethod = res.method;
          record.verificationDetails = res.details;
          if (res.verified) {
            record.status = 'VERIFIED_APPLIED';
          } else if (res.verificationStatus === 'NOT_APPLIED') {
            record.status = 'NOT_APPLIED_FLAGGED';
          }
        }

        if (res.verified) verifiedCount++;
        else if (res.verificationStatus === 'NOT_APPLIED') notAppliedCount++;
        else errorCount++;

        report.push(res);

        // Gentle pause between requests to prevent anti-bot tripping
        await sleep(1500 + Math.random() * 1500);
      }

    } catch (portalErr) {
      log(`❌ Error in portal batch verification for ${portalName}: ${portalErr.message}`);
    } finally {
      if (ctx) await ctx.close().catch(() => {});
    }
  }

  // Save updated database
  if (!dryRun) {
    saveAppliedJobs(db);
    log(`💾 Updated applied-jobs.json with live verification results.`);
  }

  log(`\n=======================================================`);
  log(`📊 Verification Run Summary`);
  log(`=======================================================`);
  log(`  Total Evaluated:       ${report.length}`);
  log(`  ✅ Successfully Applied: ${verifiedCount}`);
  log(`  ❌ Not Applied / Missed: ${notAppliedCount}`);
  log(`  ⚠️ Inconclusive / Errors: ${errorCount}`);
  log(`=======================================================\n`);

  if (report.length > 0) {
    console.table(report.map(r => ({
      Title: (r.title || '').slice(0, 30),
      Company: (r.company || '').slice(0, 20),
      Portal: r.portal || 'Naukri',
      Status: r.verificationStatus,
      Confidence: r.confidence ? `${Math.round(r.confidence * 100)}%` : 'N/A',
      Method: r.method,
    })));
  }

  return {
    total: report.length,
    verifiedCount,
    notAppliedCount,
    errorCount,
    report,
  };
}

// CLI Execution Support
if (require.main === module) {
  const args = process.argv.slice(2);
  const visible = args.includes('visible') || args.includes('--visible');
  const dryRun = args.includes('dry') || args.includes('--dry-run');
  const todayOnly = args.includes('--today') || args.includes('today');
  const allJobs = args.includes('--all') || args.includes('all');

  const portalArg = args.find(a => a.startsWith('--portal='));
  const portalFilter = portalArg ? portalArg.split('=')[1] : null;

  const jobIdArg = args.find(a => a.startsWith('--jobId=') || a.startsWith('--job='));
  const jobIdFilter = jobIdArg ? jobIdArg.split('=')[1] : null;

  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 25;

  runVerificationSuite({
    portalFilter,
    jobIdFilter,
    todayOnly,
    allJobs,
    limit,
    visible,
    dryRun,
  }).catch((err) => {
    log(`Fatal error running verification suite: ${err.stack || err.message}`);
    process.exit(1);
  });
}

module.exports = {
  runVerificationSuite,
  inspectPageForAppliedStatus,
  verifyJobOnLiveSite,
  verifyPostSubmission,
  fetchPortalDashboardApplications,
};
