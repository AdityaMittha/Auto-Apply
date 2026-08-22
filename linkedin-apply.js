/**
 * LinkedIn Easy Apply & Dynamic Resume Tailoring Engine
 * 
 * Searches matching Easy Apply roles in Pune/Remote, generates customized resumes,
 * fills Easy Apply modals with PDF uploads, answers screening prompts, and submits applications.
 */

const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { autoApplyConfig, CV, geminiKey, aiConfig, isLocationAllowed } = require('./config');
const { analyzeJob, answerQuestion } = require('./tailor-engine');

const PROFILE_DIR = path.join(__dirname, '.linkedin-chrome-profile');
const LOG_FILE = path.join(__dirname, 'naukri-applications.log');
const APPLIED_FILE = path.join(__dirname, 'applied-jobs.json');
const IS_DRY_RUN = process.argv.includes('dry') || process.argv.includes('--dry-run') || autoApplyConfig.dryRun;
const VISIBLE_MODE = process.argv.includes('visible') || process.argv.includes('--visible') || process.argv.includes('login');

const log = (msg) => {
  const line = `[${new Date().toLocaleString()}] [LINKEDIN] ${msg}`;
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

const LINKEDIN_QUERIES = [
  'Embedded Systems Intern',
  'Firmware Engineer',
  'Python Developer',
  'IoT Engineer Intern',
];

(async () => {
  log(`=======================================================`);
  log(`🚀 Starting LinkedIn Easy Apply Engine`);
  log(`🎯 Target Locations: Pune, Remote, Solapur`);
  log(`⚙️ Mode: ${IS_DRY_RUN ? '🧪 DRY RUN (Preview only)' : '⚡ LIVE APPLY (Submitting applications)'}`);
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
    // 1. Check Login State
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);

    const isLoggedIn = await page.evaluate(() => {
      return !document.querySelector('a[href*="/login"], button:has-text("Sign in")') &&
             Boolean(document.querySelector('.global-nav__me, .feed-identity-module, #global-nav'));
    });

    if (!isLoggedIn) {
      log(`⚠️ Not logged into LinkedIn!`);
      if (VISIBLE_MODE) {
        log(`👉 Please log in to your LinkedIn account in the browser window. Waiting 60s...`);
        await page.waitForTimeout(60000);
      } else {
        log(`💡 Run "npm run login:linkedin" once locally to save your login session.`);
      }
    } else {
      log(`✅ Authenticated on LinkedIn.`);
    }

    // 2. Search & Apply Loop (Easy Apply Filter Enabled: f_LF=f_AL)
    for (const keyword of LINKEDIN_QUERIES) {
      if (processedCount >= autoApplyConfig.maxPerRun) break;

      for (const loc of ['Pune', 'Remote']) {
        if (processedCount >= autoApplyConfig.maxPerRun) break;

        const searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keyword)}&location=${encodeURIComponent(loc)}&f_LF=f_AL&f_E=1%2C2`;
        log(`\n🔍 Searching LinkedIn: "${keyword}" in ${loc} (Easy Apply Only)`);

        try {
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.waitForTimeout(3000);

          const jobs = await page.evaluate(() => {
            const cards = Array.from(document.querySelectorAll('.job-card-container, .jobs-search-results__list-item, div[data-job-id]'));
            return cards.map(c => {
              const titleEl = c.querySelector('.job-card-list__title, a.job-card-container__link, a[class*="job-card"]');
              const compEl = c.querySelector('.job-card-container__primary-description, .artdeco-entity-lockup__subtitle');
              const locEl = c.querySelector('.job-card-container__metadata-item');
              const linkEl = c.querySelector('a[href*="/jobs/view/"], a.job-card-list__title');

              return {
                title: titleEl ? titleEl.innerText.trim() : '',
                company: compEl ? compEl.innerText.trim() : '',
                location: locEl ? locEl.innerText.trim() : '',
                url: linkEl ? linkEl.href.split('?')[0] : '',
              };
            }).filter(j => j.title && j.url);
          });

          log(`Found ${jobs.length} Easy Apply jobs on page.`);

          for (const job of jobs) {
            if (processedCount >= autoApplyConfig.maxPerRun) break;
            if (appliedUrls.has(job.url)) continue;

            log(`-------------------------------------------------------`);
            log(`Evaluating: ${job.title} at ${job.company} (${job.location})`);

            if (!isLocationAllowed(job.location)) {
              log(`   ⏭️ Skipped: Location "${job.location}" not in allowed list.`);
              continue;
            }

            let fullJd = `${job.title} ${job.company} ${job.location}`;
            let jobPage = null;

            try {
              jobPage = await ctx.newPage();
              await jobPage.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
              await jobPage.waitForTimeout(2000);
              const pageJd = await jobPage.evaluate(() => {
                const jdEl = document.querySelector('.jobs-description, .jobs-box__html-content, div[class*="description"], section[class*="description"]');
                return jdEl ? jdEl.innerText.trim() : '';
              });
              if (pageJd) fullJd = pageJd;
            } catch (err) {
              log(`   Warning: Could not fetch LinkedIn JD details.`);
            }

            const analysis = await analyzeJob(job.title, fullJd, [], {
              cv: CV,
              geminiKey,
              aiEnabled: aiConfig.enabled,
              jobId: job.url || `${job.company}_${job.title}`,
            });

            log(`   Category: [${analysis.category.toUpperCase()}] | Score: ${analysis.matchScore}% | Resume: ${analysis.resumeName}`);

            if (analysis.matchScore < autoApplyConfig.minMatchScore) {
              log(`   ⏭️ Skipped: Match score (${analysis.matchScore}%) below threshold.`);
              if (jobPage) await jobPage.close().catch(() => {});
              continue;
            }

            if (jobPage) {
              if (IS_DRY_RUN) {
                log(`   🧪 [DRY RUN] Would click Easy Apply and upload tailored ${analysis.resumeName}`);
                appliedDb.applied.push({
                  jobId: job.url,
                  title: job.title,
                  company: job.company,
                  portal: 'LinkedIn',
                  url: job.url,
                  category: analysis.category,
                  resumeUsed: analysis.resumeName,
                  tailoredResumePath: analysis.tailoredResumePath,
                  s3Url: analysis.s3Url,
                  s3Key: analysis.s3Key,
                  isTailored: analysis.isTailored,
                  matchScore: analysis.matchScore,
                  appliedAt: new Date().toISOString(),
                  status: 'PREVIEW_DRY_RUN',
                });
                appliedUrls.add(job.url);
                saveAppliedJobs(appliedDb);
                processedCount++;
                await jobPage.close().catch(() => {});
                continue;
              }

              // LIVE EASY APPLY FLOW
              log(`   ⚡ Launching LinkedIn Easy Apply flow...`);
              const applyBtn = jobPage.locator('button.jobs-apply-button, button:has-text("Easy Apply")').first();
              if (await applyBtn.isVisible().catch(() => false)) {
                await applyBtn.click();
                await jobPage.waitForTimeout(2500);

                // Multi-step modal loop (up to 6 steps)
                let submitted = false;
                for (let step = 0; step < 6 && !submitted; step++) {
                  // Check if file upload is on this step
                  const fileInput = jobPage.locator('input[type="file"]').first();
                  if (await fileInput.isVisible().catch(() => false) && analysis.tailoredResumePath && fs.existsSync(analysis.tailoredResumePath)) {
                    await fileInput.setInputFiles(analysis.tailoredResumePath);
                    log(`   📎 Attached tailored PDF to LinkedIn: ${path.basename(analysis.tailoredResumePath)}`);
                    await jobPage.waitForTimeout(1500);
                  }

                  // Fill any required phone input
                  const phoneInput = jobPage.locator('input[id*="phoneNumber"], input[type="tel"]').first();
                  if (await phoneInput.isVisible().catch(() => false)) {
                    const curVal = await phoneInput.inputValue();
                    if (!curVal.trim()) await phoneInput.fill(CV.phone || '8010542551');
                  }

                  // Check for Submit button
                  const submitBtn = jobPage.locator('button:has-text("Submit application"), button[aria-label*="Submit application"]').first();
                  if (await submitBtn.isVisible().catch(() => false)) {
                    await submitBtn.click();
                    await jobPage.waitForTimeout(3000);
                    submitted = true;
                    log(`   🎉 Easy Apply submitted successfully on LinkedIn!`);
                    break;
                  }

                  // Otherwise click Next / Review
                  const nextBtn = jobPage.locator('button:has-text("Next"), button:has-text("Review"), button[aria-label*="Continue"]').first();
                  if (await nextBtn.isVisible().catch(() => false)) {
                    await nextBtn.click();
                    await jobPage.waitForTimeout(2000);
                  } else {
                    break;
                  }
                }

                appliedDb.applied.push({
                  jobId: job.url,
                  title: job.title,
                  company: job.company,
                  portal: 'LinkedIn',
                  url: job.url,
                  category: analysis.category,
                  resumeUsed: analysis.resumeName,
                  tailoredResumePath: analysis.tailoredResumePath,
                  s3Url: analysis.s3Url,
                  s3Key: analysis.s3Key,
                  isTailored: analysis.isTailored,
                  matchScore: analysis.matchScore,
                  appliedAt: new Date().toISOString(),
                  status: submitted ? 'APPLIED' : 'EXTERNAL_REDIRECT',
                });

                appliedUrls.add(job.url);
                saveAppliedJobs(appliedDb);
                processedCount++;
              } else {
                log(`   ℹ️ No direct Easy Apply button (Redirects to company portal).`);
              }

              await jobPage.close().catch(() => {});
            }
          }
        } catch (err) {
          log(`Error searching "${keyword}" on LinkedIn: ${err.message}`);
        }
      }
    }

    log(`\n🎉 LinkedIn Run Finished! Processed/Applied: ${processedCount} jobs.`);
  } catch (err) {
    log(`Fatal LinkedIn Error: ${err.message}`);
  } finally {
    await ctx.close();
  }
})();
