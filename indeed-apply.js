/**
 * Indeed India Application & Resume Tailoring Engine
 * 
 * Searches matching tech roles in Pune/Remote on Indeed India,
 * compiles custom LaTeX resumes, and automates Indeed Apply where available.
 */

const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { autoApplyConfig, CV, geminiKey, aiConfig, isLocationAllowed } = require('./config');
const { analyzeJob, answerQuestion } = require('./tailor-engine');

const PROFILE_DIR = path.join(__dirname, '.indeed-chrome-profile');
const LOG_FILE = path.join(__dirname, 'naukri-applications.log');
const APPLIED_FILE = path.join(__dirname, 'applied-jobs.json');
const IS_DRY_RUN = process.argv.includes('dry') || process.argv.includes('--dry-run') || autoApplyConfig.dryRun;
const VISIBLE_MODE = process.argv.includes('visible') || process.argv.includes('--visible') || process.argv.includes('login');

const log = (msg) => {
  const line = `[${new Date().toLocaleString()}] [INDEED] ${msg}`;
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

const INDEED_QUERIES = [
  'Embedded Systems Intern',
  'Firmware Engineer',
  'Python Developer',
  'IoT Intern',
];

(async () => {
  log(`=======================================================`);
  log(`🚀 Starting Indeed India Application Engine`);
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
    for (const keyword of INDEED_QUERIES) {
      if (processedCount >= autoApplyConfig.maxPerRun) break;

      for (const loc of ['Pune', 'Remote']) {
        if (processedCount >= autoApplyConfig.maxPerRun) break;

        const searchUrl = `https://in.indeed.com/jobs?q=${encodeURIComponent(keyword)}&l=${encodeURIComponent(loc)}&fromage=14`;
        log(`\n🔍 Searching Indeed: "${keyword}" in ${loc}`);

        try {
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.waitForTimeout(3000);

          const jobs = await page.evaluate(() => {
            const cards = Array.from(document.querySelectorAll('.job_seen_beacon, .result, div[class*="cardOutline"]'));
            return cards.map(c => {
              const titleEl = c.querySelector('h2.jobTitle span, a[data-jk]');
              const compEl = c.querySelector('[data-testid="company-name"], .companyName');
              const locEl = c.querySelector('[data-testid="text-location"], .companyLocation');
              const linkEl = c.querySelector('h2.jobTitle a, a[data-jk]');

              return {
                title: titleEl ? titleEl.innerText.trim() : '',
                company: compEl ? compEl.innerText.trim() : '',
                location: locEl ? locEl.innerText.trim() : '',
                url: linkEl ? (linkEl.href.startsWith('http') ? linkEl.href : `https://in.indeed.com${linkEl.getAttribute('href')}`) : '',
              };
            }).filter(j => j.title && j.url);
          });

          log(`Found ${jobs.length} jobs on Indeed.`);

          for (const job of jobs) {
            if (processedCount >= autoApplyConfig.maxPerRun) break;
            if (appliedUrls.has(job.url)) continue;

            if (!isLocationAllowed(job.location)) {
              log(`   ⏭️ Skipped: Location "${job.location}" not allowed.`);
              continue;
            }

            let fullJd = `${job.title} ${job.company} ${job.location}`;
            let jobPage = null;
            try {
              jobPage = await ctx.newPage();
              await jobPage.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
              await jobPage.waitForTimeout(2000);
              const pageJd = await jobPage.evaluate(() => {
                const jdEl = document.querySelector('#jobDescriptionText, .jobsearch-jobDescriptionText');
                return jdEl ? jdEl.innerText.trim() : '';
              });
              if (pageJd) fullJd = pageJd;
            } catch (err) {
              log(`   Warning: Could not fetch Indeed detail page.`);
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

            let applyStatus = 'EXTERNAL_REDIRECT';

            if (jobPage) {
              const applyBtn = jobPage.locator('#indeedApplyButton, button:has-text("Apply now"), button:has-text("Apply on company site")').first();
              if (await applyBtn.isVisible().catch(() => false)) {
                const btnText = await applyBtn.innerText();
                if (/apply now|indeed apply/i.test(btnText)) {
                  if (!IS_DRY_RUN) {
                    await applyBtn.click();
                    await jobPage.waitForTimeout(3000);

                    // File upload if present
                    const fileInput = jobPage.locator('input[type="file"]').first();
                    if (await fileInput.isVisible().catch(() => false) && analysis.tailoredResumePath && fs.existsSync(analysis.tailoredResumePath)) {
                      await fileInput.setInputFiles(analysis.tailoredResumePath);
                      log(`   📎 Attached tailored PDF: ${path.basename(analysis.tailoredResumePath)}`);
                    }

                    const continueBtn = jobPage.locator('button:has-text("Continue"), button:has-text("Submit your application")').first();
                    if (await continueBtn.isVisible().catch(() => false)) {
                      await continueBtn.click();
                      await jobPage.waitForTimeout(3000);
                      applyStatus = 'APPLIED';
                      log(`   🎉 Application submitted on Indeed!`);
                    }
                  } else {
                    applyStatus = 'PREVIEW_DRY_RUN';
                  }
                }
              }

              appliedDb.applied.push({
                jobId: job.url,
                title: job.title,
                company: job.company,
                portal: 'Indeed',
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

              await jobPage.close().catch(() => {});
            }
          }
        } catch (err) {
          log(`Error searching Indeed: ${err.message}`);
        }
      }
    }

    log(`\n🎉 Indeed Run Finished! Processed: ${processedCount} jobs.`);
  } catch (err) {
    log(`Fatal Indeed Error: ${err.message}`);
  } finally {
    await ctx.close();
  }
})();
