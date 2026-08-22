/**
 * Foundit (formerly Monster India) Job & Internship Crawler.
 */
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { CV, autoApplyConfig, geminiKey, aiConfig, isLocationAllowed } = require('./config');
const { analyzeJob } = require('./tailor-engine');

const PROFILE_DIR = path.join(__dirname, '.foundit-chrome-profile');
const APPLIED_FILE = path.join(__dirname, 'applied-jobs.json');
const LOG_FILE = path.join(__dirname, 'naukri-applications.log');

const IS_DRY_RUN = process.argv.includes('--dry-run') || process.argv.includes('dry') || autoApplyConfig.dryRun;
const VISIBLE_MODE = process.argv.includes('visible') || process.argv.includes('--visible');

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

(async () => {
  log(`=======================================================`);
  log(`🚀 Starting Foundit Engine (Dry Run: ${IS_DRY_RUN ? 'YES' : 'NO'}, Mode: ${VISIBLE_MODE ? 'Visible' : 'Off-screen'})`);
  log(`=======================================================`);

  const appliedDb = loadAppliedJobs();
  const appliedUrls = new Set(appliedDb.applied.map(a => a.url));

  const IS_LINUX = process.platform === 'linux';
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
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
  let processedCount = 0;

  try {
    for (const keyword of autoApplyConfig.keywords.slice(0, 3)) {
      if (processedCount >= autoApplyConfig.maxPerRun) break;

      const searchUrl = `https://www.foundit.in/srp/results?query=${encodeURIComponent(keyword)}&locations=Pune,Solapur&experienceRanges=0~1`;
      log(`🔍 Searching Foundit: "${keyword}" -> ${searchUrl}`);

      try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(3000);

        const jobs = await page.evaluate(() => {
          const cards = Array.from(document.querySelectorAll('.srpResultCard, div[data-testid="job-card"], div.job-card'));
          return cards.map(c => {
            const titleEl = c.querySelector('.jobTitle a, a[class*="jobTitle"], h3 a');
            const compEl = c.querySelector('.companyName a, div.companyName, [class*="companyName"]');
            const locEl = c.querySelector('.location, div.location, [class*="location"]');
            const link = titleEl ? titleEl.href : '';

            return {
              title: titleEl ? titleEl.innerText.trim() : '',
              company: compEl ? compEl.innerText.trim() : '',
              location: locEl ? locEl.innerText.trim() : '',
              url: link,
            };
          }).filter(j => j.title && j.url);
        });

        log(`Found ${jobs.length} Foundit listings.`);

        for (const job of jobs) {
          if (processedCount >= autoApplyConfig.maxPerRun) break;
          if (appliedUrls.has(job.url)) continue;

          log(`-------------------------------------------------------`);
          log(`Evaluating: ${job.title} at ${job.company} (${job.location})`);

          // Location filter — skip jobs not in Pune/Remote/Solapur
          if (!isLocationAllowed(job.location)) {
            log(`   ⏭️ Skipped: Location "${job.location}" not in allowed list (Pune/Remote/Solapur).`);
            continue;
          }

          const analysis = await analyzeJob(job.title, `${job.title} ${job.company} ${job.location}`, [], {
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
            portal: 'Foundit',
            url: job.url,
            category: analysis.category,
            resumeUsed: analysis.resumeName,
            tailoredResumePath: analysis.tailoredResumePath || analysis.selectedResume,
            s3Url: analysis.s3Url || null,
            s3Key: analysis.s3Key || null,
            isTailored: analysis.isTailored || false,
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
        }
      } catch (err) {
        log(`Error searching Foundit: ${err.message}`);
      }
    }

    log(`\n🎉 Foundit Run Finished! Processed: ${processedCount} jobs.`);
  } catch (err) {
    log(`Fatal Foundit Error: ${err.message}`);
  } finally {
    await ctx.close();
  }
})();
