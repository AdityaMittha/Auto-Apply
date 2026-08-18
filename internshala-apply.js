/**
 * Internshala Crawler & Auto-Apply Engine — Searches and evaluates
 * internships on Internshala, matches against your skillset, and tracks applications.
 */
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { CV, autoApplyConfig } = require('./config');
const { analyzeJob } = require('./tailor-engine');

const PROFILE_DIR = path.join(__dirname, '.internshala-chrome-profile');
const APPLIED_FILE = path.join(__dirname, 'applied-jobs.json');
const LOG_FILE = path.join(__dirname, 'naukri-applications.log');

const IS_DRY_RUN = process.argv.includes('--dry-run') || process.argv.includes('dry') || autoApplyConfig.dryRun;
const VISIBLE_MODE = process.argv.includes('visible') || process.argv.includes('--visible');

const log = (msg) => {
  const line = `[${new Date().toLocaleString()}] [INTERNSHALA] ${msg}`;
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

const INTERNSHALA_SLUGS = [
  'embedded-systems-internship',
  'iot-internship',
  'python-django-internship',
  'firmware-development-internship'
];

(async () => {
  log(`=======================================================`);
  log(`🚀 Starting Internshala Engine (Dry Run: ${IS_DRY_RUN ? 'YES' : 'NO'}, Mode: ${VISIBLE_MODE ? 'Visible' : 'Off-screen'})`);
  log(`🎯 Target Domains: ${INTERNSHALA_SLUGS.join(', ')}`);
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
    for (const slug of INTERNSHALA_SLUGS) {
      if (processedCount >= autoApplyConfig.maxPerRun) break;

      const url = `https://internshala.com/internships/${slug}/`;
      log(`\n🔍 Crawling: ${url}`);

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(3000);

        const internships = await page.evaluate(() => {
          const cards = Array.from(document.querySelectorAll('.individual_internship, .internship_meta, div[id*="individual_internship"]'));
          return cards.map(c => {
            const titleEl = c.querySelector('.job-internship-name, .profile, h3.heading_4_5 a, a.view_detail_button');
            const compEl = c.querySelector('.company-name, .company_name a, .link_display_like_text');
            const locEl = c.querySelector('.location_link, #location_names, .locations a');
            const stipendEl = c.querySelector('.stipend');
            const detailBtn = c.querySelector('a.view_detail_button, a[href*="/internship/detail/"]');

            return {
              title: titleEl ? titleEl.innerText.trim() : '',
              company: compEl ? compEl.innerText.trim() : '',
              location: locEl ? locEl.innerText.trim() : 'Remote / India',
              stipend: stipendEl ? stipendEl.innerText.trim() : 'Unspecified',
              url: detailBtn ? detailBtn.href : (titleEl ? titleEl.href : ''),
            };
          }).filter(i => i.title && i.url);
        });

        log(`Found ${internships.length} internships on page.`);

        for (const item of internships) {
          if (processedCount >= autoApplyConfig.maxPerRun) break;
          if (appliedUrls.has(item.url)) continue;

          log(`-------------------------------------------------------`);
          log(`Evaluating: ${item.title} at ${item.company} (${item.location})`);

          // Evaluate with tailor engine
          const analysis = analyzeJob(item.title, `${item.title} ${item.location}`, []);
          log(`   Category: [${analysis.category.toUpperCase()}] | Score: ${analysis.matchScore}% | Resume: ${analysis.resumeName}`);

          appliedDb.applied.push({
            jobId: item.url,
            title: item.title,
            company: item.company,
            portal: 'Internshala',
            url: item.url,
            category: analysis.category,
            resumeUsed: analysis.resumeName,
            matchScore: analysis.matchScore,
            appliedAt: new Date().toISOString(),
            status: IS_DRY_RUN ? 'PREVIEW_DRY_RUN' : 'APPLIED',
          });

          appliedUrls.add(item.url);
          saveAppliedJobs(appliedDb);
          processedCount++;
        }
      } catch (err) {
        log(`Error processing ${slug}: ${err.message}`);
      }
    }

    log(`\n🎉 Internshala Run Completed! Evaluated/Processed: ${processedCount} internships.`);
  } catch (err) {
    log(`Fatal Error: ${err.message}`);
  } finally {
    await ctx.close();
  }
})();
