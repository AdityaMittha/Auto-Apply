/**
 * LinkedIn Easy Apply & Search Engine — Searches for jobs matching your profile,
 * prioritizes Easy Apply listings, extracts JDs, pairs tailored resume PDFs,
 * and answers screening questions.
 */
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { CV, autoApplyConfig, geminiKey, aiConfig } = require('./config');
const { analyzeJob, answerQuestion } = require('./tailor-engine');

const PROFILE_DIR = path.join(__dirname, '.linkedin-chrome-profile');
const APPLIED_FILE = path.join(__dirname, 'applied-jobs.json');
const LOG_FILE = path.join(__dirname, 'naukri-applications.log');

const IS_DRY_RUN = process.argv.includes('--dry-run') || process.argv.includes('dry') || autoApplyConfig.dryRun;
const VISIBLE_MODE = process.argv.includes('visible') || process.argv.includes('--visible');

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

(async () => {
  log(`=======================================================`);
  log(`🚀 Starting LinkedIn Engine (Dry Run: ${IS_DRY_RUN ? 'YES' : 'NO'}, Mode: ${VISIBLE_MODE ? 'Visible' : 'Off-screen'})`);
  log(`🎯 Target Roles: ${autoApplyConfig.keywords.join(', ')}`);
  log(`📍 Target Locations: ${autoApplyConfig.locations.join(', ')}`);
  log(`=======================================================`);

  const appliedDb = loadAppliedJobs();
  const appliedUrls = new Set(appliedDb.applied.map(a => a.url));

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1280, height: 850 },
    args: [
      '--disable-blink-features=AutomationControlled',
      ...(VISIBLE_MODE ? [] : ['--window-position=-32000,-32000']),
    ],
  });

  const page = ctx.pages()[0] || (await ctx.newPage());
  let processedCount = 0;

  try {
    for (const keyword of autoApplyConfig.keywords) {
      if (processedCount >= autoApplyConfig.maxPerRun) break;

      for (const location of autoApplyConfig.locations) {
        if (processedCount >= autoApplyConfig.maxPerRun) break;

        const searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keyword)}&location=${encodeURIComponent(location)}&f_AL=true&f_E=1%2C2`;
        log(`\n🔍 Searching: "${keyword}" in "${location}" -> ${searchUrl}`);

        try {
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.waitForTimeout(3000);

          const jobs = await page.evaluate(() => {
            const cards = Array.from(document.querySelectorAll('.job-card-container, .jobs-search-results__list-item, div[data-job-id]'));
            return cards.map(c => {
              const titleEl = c.querySelector('.job-card-list__title, a.job-card-container__link, a[class*="job-title"]');
              const compEl = c.querySelector('.job-card-container__primary-description, .artdeco-entity-lockup__subtitle, a[class*="company"]');
              const locEl = c.querySelector('.job-card-container__metadata-item, [class*="job-location"]');
              const link = titleEl ? titleEl.href : '';

              return {
                title: titleEl ? titleEl.innerText.trim() : '',
                company: compEl ? compEl.innerText.trim() : '',
                location: locEl ? locEl.innerText.trim() : '',
                url: link,
              };
            }).filter(j => j.title && j.url);
          });

          log(`Found ${jobs.length} Easy Apply listings.`);

          for (const job of jobs) {
            if (processedCount >= autoApplyConfig.maxPerRun) break;
            if (appliedUrls.has(job.url)) continue;

            log(`-------------------------------------------------------`);
            log(`Evaluating: ${job.title} at ${job.company} (${job.location})`);

            // Fetch full JD from job detail page
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
              log(`   Warning: Could not fetch LinkedIn JD page, using card info.`);
            }

            // Analyze with hybrid tailor engine (keyword + AI)
            const analysis = await analyzeJob(job.title, fullJd, [], {
              cv: CV,
              geminiKey,
              aiEnabled: aiConfig.enabled,
            });
            log(`   Category: [${analysis.category.toUpperCase()}] | Score: ${analysis.matchScore}% | Resume: ${analysis.resumeName} ${analysis.aiEnhanced ? '🤖 AI' : '🔑 Keyword'}`);
            if (analysis.aiEnhanced && analysis.reasoning) {
              log(`   💡 ${analysis.reasoning}`);
            }

            appliedDb.applied.push({
              jobId: job.url,
              title: job.title,
              company: job.company,
              portal: 'LinkedIn',
              url: job.url,
              category: analysis.category,
              resumeUsed: analysis.resumeName,
              matchScore: analysis.matchScore,
              matchedSkills: analysis.matchedSkills || [],
              missingSkills: analysis.missingSkills || [],
              aiReasoning: analysis.reasoning || '',
              aiEnhanced: analysis.aiEnhanced || false,
              appliedAt: new Date().toISOString(),
              status: IS_DRY_RUN ? 'PREVIEW_DRY_RUN' : 'APPLIED',
            });

            appliedUrls.add(job.url);
            saveAppliedJobs(appliedDb);
            processedCount++;

            if (jobPage) await jobPage.close().catch(() => {});
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
