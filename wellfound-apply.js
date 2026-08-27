/**
 * Wellfound (AngelList) Application & Resume Tailoring Engine
 * 
 * Searches startup engineering roles in Pune/Remote, compiles custom LaTeX resumes,
 * and handles Wellfound application modals.
 */

const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { autoApplyConfig, CV, geminiKey, aiConfig, isLocationAllowed, getEffectiveMinScore } = require('./config');
const { analyzeJob } = require('./tailor-engine');
const { generateCoverLetter } = require('./gemini-ai');
const { applyToCareerPage } = require('./career-page-engine');

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
  const actualApplied = appliedDb.applied.filter(a => a.status === 'APPLIED' || a.status === 'EXTERNAL_REDIRECT');
  const appliedUrls = new Set(actualApplied.map(a => a.jobId || a.url).filter(Boolean));

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

  const IS_LOGIN_MODE = process.argv.includes('login');

  try {
    // 1. Verify Login State
    await page.goto('https://wellfound.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);

    let isLoggedIn = await page.evaluate(() => {
      return !document.querySelector('a[href*="/login"]') &&
             Boolean(document.querySelector('[data-test="user-nav"], [class*="userNav"]'));
    });

    if (!isLoggedIn || IS_LOGIN_MODE) {
      log(`🔑 Launching Wellfound Google sign-in flow...`);
      await page.goto('https://wellfound.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2000);

      const googleBtn = page.locator('button:has-text("Google"), a[href*="google"], [class*="google"]').first();
      if (await googleBtn.isVisible().catch(() => false)) {
        await googleBtn.click();
        let g = null;
        for (let i = 0; i < 15 && !g; i++) {
          await page.waitForTimeout(1000);
          g = ctx.pages().find((p) => /accounts\.google\./.test(p.url())) || null;
        }
        if (g) {
          await g.waitForLoadState('domcontentloaded').catch(() => {});
          const knownAccount = g.locator(`[data-email="${CREDS.email}"]`).first();
          if (await knownAccount.isVisible().catch(() => false)) {
            await knownAccount.click();
          }
        }
      }

      log(`   ⏳ Waiting for Wellfound account verification...`);
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        const pages = ctx.pages();
        const authed = pages.find(p => /wellfound\.com/i.test(p.url()) && !/login/i.test(p.url()));
        if (authed) {
          isLoggedIn = true;
          break;
        }
        await page.waitForTimeout(2000);
      }

      if (isLoggedIn) {
        log(`🎉 Successfully logged into Wellfound! Session saved in .wellfound-chrome-profile.`);
        if (IS_LOGIN_MODE) {
          log(`✅ Login complete. You can now run "npm run apply:wellfound" or "npm run apply:all".`);
          return;
        }
      } else {
        log(`⚠️ Wellfound login did not complete within the timeout.`);
        if (IS_LOGIN_MODE) {
          await page.waitForTimeout(30000);
          return;
        }
      }
    } else {
      log(`✅ Authenticated on Wellfound.`);
    }

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

      log(`-------------------------------------------------------`);
      log(`Evaluating: ${job.title} at ${job.company} (${job.location})`);

      // Fetch full JD from detail page
      let fullJd = `${job.title} ${job.company} ${job.location}`;
      let jobPage = null;
      try {
        jobPage = await ctx.newPage();
        await jobPage.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await jobPage.waitForTimeout(2000);

        const pageJd = await jobPage.evaluate(() => {
          const jdEl = document.querySelector('.description, [data-test="JobDescription"], [class*="description"], [class*="job-details"], div[class*="styles_description"]');
          return jdEl ? jdEl.innerText.trim() : '';
        });
        if (pageJd) fullJd = pageJd;
      } catch (err) {
        log(`   Warning: Could not fetch detailed Wellfound JD page.`);
      }

      const analysis = await analyzeJob(job.title, fullJd, [], {
        cv: CV,
        geminiKey,
        aiEnabled: aiConfig.enabled,
        jobId: job.url || `${job.company}_${job.title}`,
      });

      const effectiveMin = getEffectiveMinScore(job.title, fullJd, analysis.category);
      log(`   Category: [${analysis.category.toUpperCase()}] | Score: ${analysis.matchScore}% (Min: ${effectiveMin}%) | Resume: ${analysis.resumeName}`);

      if (analysis.matchScore < effectiveMin) {
        log(`   ⏭️ Skipped: Match score (${analysis.matchScore}%) below threshold (${effectiveMin}%).`);
        if (jobPage) await jobPage.close().catch(() => {});
        continue;
      }

      let applyStatus = 'APPLIED';
      let externalUrl = job.url;
      let portalName = 'Wellfound';
      let failureReason = null;

      if (!IS_DRY_RUN && jobPage) {
        try {
          const applyBtn = jobPage.locator('button:has-text("Apply"), button[data-test="apply-button"], a:has-text("Apply")').first();
          if (await applyBtn.isVisible().catch(() => false)) {
            await applyBtn.click();
            await jobPage.waitForTimeout(2000);

            // Fill cover note if note textarea appears
            const noteArea = jobPage.locator('textarea[name="note"], textarea[placeholder*="note"]').first();
            if (await noteArea.isVisible().catch(() => false)) {
              const noteText = await generateCoverLetter({
                title: job.title,
                company: job.company,
                jdText: fullJd,
                category: analysis.category,
                cv: CV,
                apiKey: geminiKey,
              }) || `I am an E&TC student at Walchand Institute of Technology (9.27 CGPA) with strong practical experience in Embedded C, FreeRTOS, and Python. Available immediately in Pune / Remote.`;
              await noteArea.fill(noteText);
            }

            const sendBtn = jobPage.locator('button:has-text("Send application"), button:has-text("Submit application")').first();
            if (await sendBtn.isVisible().catch(() => false)) {
              await sendBtn.click();
              await jobPage.waitForTimeout(3000);
              applyStatus = 'APPLIED';
              log(`   🎉 Applied on Wellfound!`);
            } else {
              // External redirect on Wellfound
              log(`   ℹ️ Wellfound external application redirect. Triggering AI Career Page Engine...`);
              const extRes = await applyToCareerPage(jobPage, job, analysis, {
                cv: CV,
                geminiKey,
                dryRun: IS_DRY_RUN,
                log,
              });
              applyStatus = extRes.status || 'APPLIED';
              externalUrl = extRes.submissionUrl || job.url;
              portalName = `Wellfound (${extRes.atsProvider || 'Company Site'})`;
              failureReason = extRes.reason || null;
            }
          } else {
            applyStatus = 'EXTERNAL_MANUAL_REQUIRED';
            failureReason = 'Apply button not found';
          }
        } catch (err) {
          applyStatus = 'EXTERNAL_MANUAL_REQUIRED';
          failureReason = err.message;
        }
      } else if (IS_DRY_RUN) {
        applyStatus = 'PREVIEW_DRY_RUN';
      }

      if (jobPage) await jobPage.close().catch(() => {});

      appliedDb.applied.push({
        jobId: job.url,
        title: job.title,
        company: job.company,
        portal: portalName,
        url: job.url,
        externalUrl,
        location: job.location,
        category: analysis.category,
        resumeUsed: analysis.resumeName,
        tailoredResumePath: analysis.tailoredResumePath,
        s3Url: analysis.s3Url,
        s3Key: analysis.s3Key,
        isTailored: analysis.isTailored,
        matchScore: analysis.matchScore,
        matchedSkills: analysis.matchedSkills || [],
        missingSkills: analysis.missingSkills || [],
        aiReasoning: analysis.reasoning || '',
        interviewTips: analysis.interviewTips || [],
        highlightedSkills: analysis.highlightedSkills || [],
        tailoredSummary: analysis.tailoredSummary || '',
        jobDescription: (fullJd || '').slice(0, 3000),
        appliedAt: new Date().toISOString(),
        status: applyStatus,
        reason: failureReason,
      });

      appliedUrls.add(job.url);
      saveAppliedJobs(appliedDb);
      if (applyStatus === 'APPLIED' || applyStatus === 'PREVIEW_DRY_RUN') {
        processedCount++;
      }
    }

    log(`\n🎉 Wellfound Run Finished! Processed: ${processedCount} jobs.`);
  } catch (err) {
    log(`Fatal Wellfound Error: ${err.message}`);
  } finally {
    await ctx.close();
  }
})();
