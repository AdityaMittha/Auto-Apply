/**
 * Application Status Tracker
 * 
 * Scrapes job portals (Naukri, Internshala, LinkedIn, etc.) to check the latest
 * status of submitted applications (e.g., Applied, Viewed by Recruiter, Shortlisted)
 * and extracts any visible recruiter contact information.
 */

const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const APPLIED_FILE = path.join(__dirname, 'applied-jobs.json');
const LOG_FILE = path.join(__dirname, 'naukri-applications.log');

const IS_DRY_RUN = process.argv.includes('--dry-run') || process.argv.includes('dry');
const VISIBLE_MODE = process.argv.includes('visible') || process.argv.includes('--visible');

const log = (msg) => {
  const line = `[${new Date().toLocaleString()}] [STATUS_TRACKER] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
};

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
 * Checks Naukri Application Status
 */
async function checkNaukriStatus() {
  const profileDir = path.join(__dirname, '.naukri-chrome-profile');
  if (!fs.existsSync(profileDir)) return [];

  const IS_LINUX = process.platform === 'linux';
  let ctx = null;
  const updates = [];

  try {
    ctx = await chromium.launchPersistentContext(profileDir, {
      channel: IS_LINUX ? 'chromium' : 'chrome',
      headless: false,
      viewport: { width: 1280, height: 850 },
      args: [
        '--disable-blink-features=AutomationControlled',
        ...(IS_LINUX ? ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] : []),
        ...(VISIBLE_MODE ? [] : ['--window-position=-32000,-32000']),
      ],
    });

    const page = ctx.pages()[0] || (await ctx.newPage());
    log(`🔍 Checking Naukri applications tracker: https://www.naukri.com/mnjuser/applications`);
    
    await page.goto('https://www.naukri.com/mnjuser/applications', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);

    const rows = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.app-history-row, .app-card, [class*="application-card"], [class*="job-tuple"]'));
      return items.map(el => {
        const titleEl = el.querySelector('.title, .designation, a[class*="title"]');
        const companyEl = el.querySelector('.company, .org, a[class*="comp-name"]');
        const statusEl = el.querySelector('.status, .app-status, [class*="status"]');
        const recruiterEl = el.querySelector('.recruiter-name, .posted-by, [class*="recruiter"]');
        return {
          title: titleEl ? titleEl.innerText.trim() : '',
          company: companyEl ? companyEl.innerText.trim() : '',
          status: statusEl ? statusEl.innerText.trim() : 'Applied',
          recruiter: recruiterEl ? recruiterEl.innerText.trim() : '',
        };
      }).filter(r => r.title || r.company);
    });

    log(`Naukri tracker: Found ${rows.length} application entries.`);
    return rows;
  } catch (err) {
    log(`Warning checking Naukri status: ${err.message}`);
    return [];
  } finally {
    if (ctx) await ctx.close().catch(() => {});
  }
}

/**
 * Checks Internshala Application Status
 */
async function checkInternshalaStatus() {
  const profileDir = path.join(__dirname, '.internshala-chrome-profile');
  if (!fs.existsSync(profileDir)) return [];

  const IS_LINUX = process.platform === 'linux';
  let ctx = null;
  const updates = [];

  try {
    ctx = await chromium.launchPersistentContext(profileDir, {
      channel: IS_LINUX ? 'chromium' : 'chrome',
      headless: false,
      viewport: { width: 1280, height: 850 },
      args: [
        '--disable-blink-features=AutomationControlled',
        ...(IS_LINUX ? ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] : []),
        ...(VISIBLE_MODE ? [] : ['--window-position=-32000,-32000']),
      ],
    });

    const page = ctx.pages()[0] || (await ctx.newPage());
    log(`🔍 Checking Internshala applications tracker: https://internshala.com/student/applications`);
    
    await page.goto('https://internshala.com/student/applications', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);

    const rows = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('#applications_table tbody tr, .application_row, .table-row'));
      return items.map(el => {
        const titleEl = el.querySelector('.profile_name, td.profile, a.view_detail_button');
        const companyEl = el.querySelector('.company_name, td.company');
        const statusEl = el.querySelector('.status, .application_status, td.status');
        return {
          title: titleEl ? titleEl.innerText.trim() : '',
          company: companyEl ? companyEl.innerText.trim() : '',
          status: statusEl ? statusEl.innerText.trim() : 'Applied',
        };
      }).filter(r => r.title || r.company);
    });

    log(`Internshala tracker: Found ${rows.length} application entries.`);
    return rows;
  } catch (err) {
    log(`Warning checking Internshala status: ${err.message}`);
    return [];
  } finally {
    if (ctx) await ctx.close().catch(() => {});
  }
}

/**
 * Main function: Run all portal status checks and update applied-jobs.json
 */
async function trackApplicationStatuses() {
  log(`=======================================================`);
  log(`🔍 Starting Application Status Check Across Portals`);
  log(`=======================================================`);

  const db = loadAppliedJobs();
  let updatedCount = 0;

  // 1. Naukri status
  const naukriUpdates = await checkNaukriStatus();
  for (const item of naukriUpdates) {
    const match = db.applied.find(a => 
      (a.portal === 'Naukri' || !a.portal) &&
      ((item.company && a.company && a.company.toLowerCase().includes(item.company.toLowerCase())) ||
       (item.title && a.title && a.title.toLowerCase().includes(item.title.toLowerCase())))
    );
    if (match) {
      const oldStatus = match.status;
      match.status = item.status || match.status;
      match.lastStatusCheckedAt = new Date().toISOString();
      if (item.recruiter && !match.recruiterName) match.recruiterName = item.recruiter;
      if (oldStatus !== match.status) {
        log(`📢 [STATUS UPDATE] ${match.company} - ${match.title}: ${oldStatus} ➡️ ${match.status}`);
        updatedCount++;
      }
    }
  }

  // 2. Internshala status
  const internshalaUpdates = await checkInternshalaStatus();
  for (const item of internshalaUpdates) {
    const match = db.applied.find(a => 
      a.portal === 'Internshala' &&
      ((item.company && a.company && a.company.toLowerCase().includes(item.company.toLowerCase())) ||
       (item.title && a.title && a.title.toLowerCase().includes(item.title.toLowerCase())))
    );
    if (match) {
      const oldStatus = match.status;
      match.status = item.status || match.status;
      match.lastStatusCheckedAt = new Date().toISOString();
      if (oldStatus !== match.status) {
        log(`📢 [STATUS UPDATE] ${match.company} - ${match.title}: ${oldStatus} ➡️ ${match.status}`);
        updatedCount++;
      }
    }
  }

  if (!IS_DRY_RUN && updatedCount > 0) {
    saveAppliedJobs(db);
    log(`💾 Saved ${updatedCount} updated application status records.`);
  } else {
    log(`Status check completed. ${updatedCount} statuses changed.`);
  }

  return { updatedCount, totalTracked: db.applied.length };
}

if (require.main === module) {
  trackApplicationStatuses();
}

module.exports = {
  trackApplicationStatuses,
  checkNaukriStatus,
  checkInternshalaStatus,
};
