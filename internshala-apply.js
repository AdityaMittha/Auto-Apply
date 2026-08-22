/**
 * Internshala Crawler & Auto-Apply Engine — Searches and evaluates
 * internships on Internshala, matches against your skillset, and tracks applications.
 */
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { CV, autoApplyConfig, geminiKey, aiConfig, isLocationAllowed } = require('./config');
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

          // Location filter — skip internships not in Pune/Remote/Solapur
          if (!isLocationAllowed(item.location)) {
            log(`   ⏭️ Skipped: Location "${item.location}" not in allowed list (Pune/Remote/Solapur).`);
            continue;
          }

          // Fetch full JD from internship detail page
          let fullJd = `${item.title} ${item.location}`;
          let detailPage = null;
          try {
            detailPage = await ctx.newPage();
            await detailPage.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
            await detailPage.waitForTimeout(2000);
            const pageJd = await detailPage.evaluate(() => {
              const jdEl = document.querySelector('.internship_details, .detail_view, div[class*="about"], div[class*="detail"]');
              return jdEl ? jdEl.innerText.trim() : '';
            });
            if (pageJd) fullJd = pageJd;
          } catch (err) {
            log(`   Warning: Could not fetch Internshala detail page, using card info.`);
          }

          // Evaluate with hybrid tailor engine (keyword + AI + LaTeX tailoring)
          const analysis = await analyzeJob(item.title, fullJd, [], {
            cv: CV,
            geminiKey,
            aiEnabled: aiConfig.enabled,
            jobId: item.url || `${item.company}_${item.title}`,
          });
          log(`   Category: [${analysis.category.toUpperCase()}] | Score: ${analysis.matchScore}% | Resume: ${analysis.resumeName} ${analysis.aiEnhanced ? '🤖 AI' : '🔑 Keyword'}`);
          if (analysis.aiEnhanced && analysis.reasoning) {
            log(`   💡 ${analysis.reasoning}`);
          }

          appliedDb.applied.push({
            jobId: item.url,
            title: item.title,
            company: item.company,
            portal: 'Internshala',
            url: item.url,
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

          appliedUrls.add(item.url);
          saveAppliedJobs(appliedDb);
          processedCount++;

          if (detailPage) await detailPage.close().catch(() => {});
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
