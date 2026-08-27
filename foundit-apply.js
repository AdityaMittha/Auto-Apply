/**
 * Foundit (Monster India) Application & Resume Tailoring Engine
 * 
 * Searches tech openings in Pune/Remote on Foundit, compiles custom LaTeX resumes,
 * and automates Quick Apply where available.
 */

const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { autoApplyConfig, CV, geminiKey, aiConfig, isLocationAllowed, getEffectiveMinScore } = require('./config');
const { analyzeJob } = require('./tailor-engine');
const { applyToCareerPage } = require('./career-page-engine');

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
    await page.goto('https://www.foundit.in/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);

    let isLoggedIn = await page.evaluate(() => {
      return !document.querySelector('a[href*="/login"], a[href*="/seeker/login"]') &&
             Boolean(document.querySelector('.userProfile, [class*="profile"], .seekerProfile'));
    });

    if (!isLoggedIn || IS_LOGIN_MODE) {
      log(`🔑 Launching Foundit login flow...`);
      await page.goto('https://www.foundit.in/seeker/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
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

      log(`   ⏳ Waiting for Foundit account verification...`);
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        const pages = ctx.pages();
        const authed = pages.find(p => /foundit\.in/i.test(p.url()) && !/login|seeker/i.test(p.url()));
        if (authed) {
          isLoggedIn = true;
          break;
        }
        await page.waitForTimeout(2000);
      }

      if (isLoggedIn) {
        log(`🎉 Successfully logged into Foundit! Session saved in .foundit-chrome-profile.`);
        if (IS_LOGIN_MODE) {
          log(`✅ Login complete. You can now run "npm run apply:foundit" or "npm run apply:all".`);
          return;
        }
      } else {
        log(`⚠️ Foundit login did not complete within the timeout.`);
        if (IS_LOGIN_MODE) {
          await page.waitForTimeout(30000);
          return;
        }
      }
    } else {
      log(`✅ Authenticated on Foundit.`);
    }

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
                const jdEl = document.querySelector('.jobDesc, .jobDescription, .job-description, [class*="job-description"], [class*="description"], div[class*="content"]');
                return jdEl ? jdEl.innerText.trim() : '';
              });
              if (pageJd) fullJd = pageJd;
            } catch (err) {
              log(`   Warning: Could not fetch detailed Foundit JD page.`);
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
            let portalName = 'Foundit';
            let failureReason = null;

            if (!IS_DRY_RUN && jobPage) {
              try {
                const applyBtn = jobPage.locator('button:has-text("Quick Apply"), button:has-text("Apply on Company Website"), button:has-text("Apply"), a:has-text("Apply")').first();
                if (await applyBtn.isVisible().catch(() => false)) {
                  const btnText = await applyBtn.innerText();
                  const isExternal = /company|external|website/i.test(btnText);

                  if (isExternal) {
                    log(`   ℹ️ External Job (Redirects to company portal). Triggering AI Career Page Engine...`);
                    let externalPage = null;
                    try {
                      const popupPromise = ctx.waitForEvent('page', { timeout: 10000 }).catch(() => null);
                      await applyBtn.click();
                      externalPage = await popupPromise;
                      if (!externalPage) {
                        await jobPage.waitForTimeout(3000);
                        externalPage = jobPage;
                      }

                      const extRes = await applyToCareerPage(externalPage, job, analysis, {
                        cv: CV,
                        geminiKey,
                        dryRun: IS_DRY_RUN,
                        log,
                      });

                      applyStatus = extRes.status || 'APPLIED';
                      externalUrl = extRes.submissionUrl || job.url;
                      portalName = `Foundit (${extRes.atsProvider || 'Company Site'})`;
                      failureReason = extRes.reason || null;
                    } catch (extErr) {
                      log(`   ⚠️ External apply failed: ${extErr.message}`);
                      applyStatus = 'EXTERNAL_MANUAL_REQUIRED';
                      failureReason = extErr.message;
                    } finally {
                      if (externalPage && externalPage !== jobPage) await externalPage.close().catch(() => {});
                    }
                  } else {
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
