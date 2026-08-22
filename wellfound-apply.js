/**
 * Wellfound (AngelList) Application & Resume Tailoring Engine
 * 
 * Searches startup engineering roles in Pune/Remote, compiles custom LaTeX resumes,
 * and handles Wellfound application modals.
 */

const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { autoApplyConfig, CV, geminiKey, aiConfig, isLocationAllowed } = require('./config');
const { analyzeJob } = require('./tailor-engine');
const { generateCoverLetter } = require('./gemini-ai');

const PROFILE_DIR = path.join(__dirname, '.wellfound-chrome-profile');
const LOG_FILE = path.join(__dirname, 'naukri-applications.log');
const APPLIED_FILE = path.join(__dirname, 'applied-jobs.json');
const IS_DRY_RUN = process.argv.includes('dry') || process.argv.includes('--dry-run') || autoApplyConfig.dryRun;
const VISIBLE_MODE = process.argv.includes('visible') || process.argv.includes('--visible') || process.argv.includes('login');

const log = (msg) => {
  const line = `[${new Date().toLocaleString()}] [WELLFOUND] ${msg}`;
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

(async () => {
  log(`=======================================================`);
  log(`🚀 Starting Wellfound (AngelList) Application Engine`);
  log(`🎯 Target Locations: Pune, Remote, Solapur`);
  log(`⚙️ Mode: ${IS_DRY_RUN ? '🧪 DRY RUN (Preview only)' : '⚡ LIVE APPLY'}`);
  log(`=======================================================`);

  const IS_LINUX = process.platform === 'linux';
  const appliedDb = loadAppliedJobs();
  const appliedUrls = new Set(appliedDb.applied.map(a => a.jobId || a.url));

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: IS_LINUX ? 'chromium' : 'chrome',
    headless: !VISIBLE_MODE && IS_LINUX,
    viewport: { width: 1280, height: 900 },
    args: [
      '--disable-blink-features=AutomationControlled',
      ...(IS_LINUX ? ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] : []),
      ...(VISIBLE_MODE ? [] : ['--window-position=-32000,-32000']),
    ],
  });

  const page = ctx.pages()[0] || (await ctx.newPage());
  let processedCount = 0;

  try {
    const url = 'https://wellfound.com/jobs?role=software-engineer&location=pune';
    log(`\n🔍 Crawling Wellfound: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);

    const jobs = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('div[data-test="JobListing"], div[class*="styles_jobListing"]'));
      return cards.map(c => {
        const titleEl = c.querySelector('a[data-test="job-title"], h2 a, a[class*="title"]');
        const compEl = c.querySelector('h3, a[class*="companyName"], div[class*="company"]');
        const locEl = c.querySelector('span[class*="location"], div[class*="location"]');

        return {
          title: titleEl ? titleEl.innerText.trim() : '',
          company: compEl ? compEl.innerText.trim() : '',
          location: locEl ? locEl.innerText.trim() : 'Pune / Remote',
          url: titleEl ? titleEl.href : '',
        };
      }).filter(j => j.title && j.url);
    });

    log(`Found ${jobs.length} jobs on Wellfound.`);

    for (const job of jobs) {
      if (processedCount >= autoApplyConfig.maxPerRun) break;
      if (appliedUrls.has(job.url)) continue;

      if (!isLocationAllowed(job.location)) {
        log(`   ⏭️ Skipped: Location "${job.location}" not allowed.`);
        continue;
      }

      const analysis = await analyzeJob(job.title, `${job.title} ${job.company} ${job.location}`, [], {
        cv: CV,
        geminiKey,
        aiEnabled: aiConfig.enabled,
        jobId: job.url || `${job.company}_${job.title}`,
      });

      log(`-------------------------------------------------------`);
      log(`Evaluating: ${job.title} at ${job.company} (${job.location})`);
      log(`   Category: [${analysis.category.toUpperCase()}] | Score: ${analysis.matchScore}% | Resume: ${analysis.resumeName}`);

      if (analysis.matchScore < autoApplyConfig.minMatchScore) {
        log(`   ⏭️ Skipped: Match score below threshold.`);
        continue;
      }

      let applyStatus = 'EXTERNAL_REDIRECT';

      if (!IS_DRY_RUN) {
        let jobPage = null;
        try {
          jobPage = await ctx.newPage();
          await jobPage.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
          await jobPage.waitForTimeout(2500);

          const applyBtn = jobPage.locator('button:has-text("Apply"), button[data-test="apply-button"]').first();
          if (await applyBtn.isVisible().catch(() => false)) {
            await applyBtn.click();
            await jobPage.waitForTimeout(2000);

            // Fill cover note if note textarea appears
            const noteArea = jobPage.locator('textarea[name="note"], textarea[placeholder*="note"]').first();
            if (await noteArea.isVisible().catch(() => false)) {
              const noteText = await generateCoverLetter({
                title: job.title,
                company: job.company,
                jdText: `${job.title} ${job.company}`,
                category: analysis.category,
                cv: CV,
                apiKey: geminiKey,
              }) || `I am an E&TC student at Walchand Institute of Technology (9.27 CGPA) with strong practical experience in Embedded C, FreeRTOS, and Python. Available immediately in Pune / Remote.`;
              await noteArea.fill(noteText);
            }

            const sendBtn = jobPage.locator('button:has-text("Send application")').first();
            if (await sendBtn.isVisible().catch(() => false)) {
              await sendBtn.click();
              await jobPage.waitForTimeout(3000);
              applyStatus = 'APPLIED';
              log(`   🎉 Applied on Wellfound!`);
            }
          }
        } catch {}
        if (jobPage) await jobPage.close().catch(() => {});
      } else {
        applyStatus = 'PREVIEW_DRY_RUN';
      }

      appliedDb.applied.push({
        jobId: job.url,
        title: job.title,
        company: job.company,
        portal: 'Wellfound',
        url: job.url,
        category: analysis.category,
        resumeUsed: analysis.resumeName,
        tailoredResumePath: analysis.tailoredResumePath,
        s3Url: analysis.s3Url,
        s3Key: analysis.s3Key,
        isTailored: analysis.isTailored,
        matchScore: analysis.matchScore,
        appliedAt: new Date().toISOString(),
        status: applyStatus,
      });

      appliedUrls.add(job.url);
      saveAppliedJobs(appliedDb);
      processedCount++;
    }

    log(`\n🎉 Wellfound Run Finished! Processed: ${processedCount} jobs.`);
  } catch (err) {
    log(`Fatal Wellfound Error: ${err.message}`);
  } finally {
    await ctx.close();
  }
})();
