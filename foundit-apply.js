/**
 * Foundit (Monster India) Application & Resume Tailoring Engine
 * 
 * Searches tech openings in Pune/Remote on Foundit, compiles custom LaTeX resumes,
 * and automates Quick Apply where available.
 */

const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { autoApplyConfig, CV, geminiKey, aiConfig, isLocationAllowed } = require('./config');
const { analyzeJob } = require('./tailor-engine');

const PROFILE_DIR = path.join(__dirname, '.foundit-chrome-profile');
const LOG_FILE = path.join(__dirname, 'naukri-applications.log');
const APPLIED_FILE = path.join(__dirname, 'applied-jobs.json');
const IS_DRY_RUN = process.argv.includes('dry') || process.argv.includes('--dry-run') || autoApplyConfig.dryRun;
const VISIBLE_MODE = process.argv.includes('visible') || process.argv.includes('--visible') || process.argv.includes('login');

const log = (msg) => {
  const line = `[${new Date().toLocaleString()}] [FOUNDIT] ${msg}`;
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

const FOUNDIT_QUERIES = [
  'Embedded Engineer',
  'Firmware Developer',
  'Python Developer',
  'IoT Intern',
];

(async () => {
  log(`=======================================================`);
  log(`🚀 Starting Foundit (Monster) Application Engine`);
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
    for (const keyword of FOUNDIT_QUERIES) {
      if (processedCount >= autoApplyConfig.maxPerRun) break;

      for (const loc of ['Pune', 'Remote']) {
        if (processedCount >= autoApplyConfig.maxPerRun) break;

        const searchUrl = `https://www.foundit.in/srp/results?query=${encodeURIComponent(keyword)}&locations=${encodeURIComponent(loc)}&experienceRanges=0~1`;
        log(`\n🔍 Searching Foundit: "${keyword}" in ${loc}`);

        try {
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.waitForTimeout(3000);

          const jobs = await page.evaluate(() => {
            const cards = Array.from(document.querySelectorAll('.srpResultCard, div[class*="jobTuple"], div[class*="srpCard"]'));
            return cards.map(c => {
              const titleEl = c.querySelector('.jobTitle a, .cardTitle, a[class*="title"]');
              const compEl = c.querySelector('.companyName, a[class*="company"]');
              const locEl = c.querySelector('.location, div[class*="location"]');

              return {
                title: titleEl ? titleEl.innerText.trim() : '',
                company: compEl ? compEl.innerText.trim() : '',
                location: locEl ? locEl.innerText.trim() : '',
                url: titleEl ? titleEl.href : '',
              };
            }).filter(j => j.title && j.url);
          });

          log(`Found ${jobs.length} jobs on Foundit.`);

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

                const applyBtn = jobPage.locator('button:has-text("Quick Apply"), button:has-text("Apply")').first();
                if (await applyBtn.isVisible().catch(() => false)) {
                  await applyBtn.click();
                  await jobPage.waitForTimeout(3000);

                  const fileInput = jobPage.locator('input[type="file"]').first();
                  if (await fileInput.isVisible().catch(() => false) && analysis.tailoredResumePath && fs.existsSync(analysis.tailoredResumePath)) {
                    await fileInput.setInputFiles(analysis.tailoredResumePath);
                    log(`   📎 Attached tailored PDF: ${path.basename(analysis.tailoredResumePath)}`);
                  }

                  applyStatus = 'APPLIED';
                  log(`   🎉 Applied on Foundit!`);
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
              portal: 'Foundit',
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
        } catch (err) {
          log(`Error searching Foundit: ${err.message}`);
        }
      }
    }

    log(`\n🎉 Foundit Run Finished! Processed: ${processedCount} jobs.`);
  } catch (err) {
    log(`Fatal Foundit Error: ${err.message}`);
  } finally {
    await ctx.close();
  }
})();
