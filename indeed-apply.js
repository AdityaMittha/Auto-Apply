/**
 * Indeed India Application & Resume Tailoring Engine
 * 
 * Searches matching tech roles in Pune/Remote on Indeed India,
 * compiles custom LaTeX resumes, and automates Indeed Apply where available.
 */

const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { autoApplyConfig, CV, geminiKey, aiConfig, isLocationAllowed, getEffectiveMinScore } = require('./config');
const { analyzeJob, answerQuestion } = require('./tailor-engine');
const { applyToCareerPage } = require('./career-page-engine');

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
    await page.goto('https://in.indeed.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);

    let isLoggedIn = await page.evaluate(() => {
      return !document.querySelector('a[href*="/account/login"], a[href*="secure.indeed.com"]') &&
             Boolean(document.querySelector('[data-gnav-element-name="ProfileMenu"], [aria-label*="Profile"]'));
    });

    if (!isLoggedIn || IS_LOGIN_MODE) {
      log(`🔑 Launching Indeed Google sign-in flow...`);
      await page.goto('https://secure.indeed.com/account/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2000);

      // Check for Google login button
      const googleBtn = page.locator('#gplus-signin-btn, button:has-text("Google"), [data-tn-element="google-login-button"]').first();
      if (await googleBtn.isVisible().catch(() => false)) {
        await googleBtn.click();
        log(`   Clicked Google sign-in button...`);

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
          } else {
            const emailBox = g.locator('input#identifierId, input[type="email"]').first();
            if (await emailBox.isVisible().catch(() => false)) {
              await emailBox.fill(CREDS.email);
              await g.locator('#identifierNext, button:has-text("Next")').first().click();
              await g.waitForTimeout(2000);
              const passBox = g.locator('input[type="password"]').first();
              if (await passBox.isVisible().catch(() => false)) {
                await passBox.fill(CREDS.password);
                await g.locator('#passwordNext, button:has-text("Next")').first().click();
              }
            }
          }
        }
      }

      log(`   ⏳ Waiting for Indeed account verification...`);
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        const pages = ctx.pages();
        const authed = pages.find(p => /indeed\.com/i.test(p.url()) && !/login|signin/i.test(p.url()));
        if (authed) {
          isLoggedIn = true;
          break;
        }
        await page.waitForTimeout(2000);
      }

      if (isLoggedIn) {
        log(`🎉 Successfully logged into Indeed! Session saved in .indeed-chrome-profile.`);
        if (IS_LOGIN_MODE) {
          log(`✅ Login complete. You can now run "npm run apply:indeed" or "npm run apply:all".`);
          return;
        }
      } else {
        log(`⚠️ Indeed login did not complete within the timeout.`);
        if (IS_LOGIN_MODE) {
          await page.waitForTimeout(30000);
          return;
        }
      }
    } else {
      log(`✅ Authenticated on Indeed.`);
    }

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

            const effectiveMin = getEffectiveMinScore(job.title, fullJd, analysis.category);
            log(`   Category: [${analysis.category.toUpperCase()}] | Score: ${analysis.matchScore}% (Min: ${effectiveMin}%) | Resume: ${analysis.resumeName}`);

            if (analysis.matchScore < effectiveMin) {
              log(`   ⏭️ Skipped: Match score (${analysis.matchScore}%) below threshold (${effectiveMin}%).`);
              if (jobPage) await jobPage.close().catch(() => {});
              continue;
            }

            let applyStatus = 'APPLIED';
            let externalUrl = job.url;
            let portalName = 'Indeed';
            let failureReason = null;

            if (jobPage) {
              const applyBtn = jobPage.locator('#indeedApplyButton, button:has-text("Apply now"), button:has-text("Apply on company site")').first();
              if (await applyBtn.isVisible().catch(() => false)) {
                const btnText = await applyBtn.innerText();
                const isCompanySite = /company site|external/i.test(btnText);

                if (isCompanySite) {
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
                    portalName = `Indeed (${extRes.atsProvider || 'Company Site'})`;
                    failureReason = extRes.reason || null;
                  } catch (extErr) {
                    log(`   ⚠️ External apply failed: ${extErr.message}`);
                    applyStatus = 'EXTERNAL_MANUAL_REQUIRED';
                    failureReason = extErr.message;
                  } finally {
                    if (externalPage && externalPage !== jobPage) await externalPage.close().catch(() => {});
                  }
                } else {
                  // Native Indeed Apply multi-step flow
                  if (!IS_DRY_RUN) {
                    log(`   ⚡ Starting Indeed native application flow...`);
                    await applyBtn.click();
                    await jobPage.waitForTimeout(3000);

                    // Multi-step loop (up to 5 steps)
                    let submitted = false;
                    for (let step = 0; step < 5 && !submitted; step++) {
                      // Attach resume if file input is visible
                      const fileInput = jobPage.locator('input[type="file"]').first();
                      if (await fileInput.isVisible().catch(() => false) && analysis.tailoredResumePath && fs.existsSync(analysis.tailoredResumePath)) {
                        await fileInput.setInputFiles(analysis.tailoredResumePath);
                        log(`   📎 Attached tailored PDF: ${path.basename(analysis.tailoredResumePath)}`);
                        await jobPage.waitForTimeout(1500);
                      }

                      // Check for question inputs on this step
                      const textInputs = await jobPage.$$('input[type="text"]:visible, textarea:visible');
                      for (const ti of textInputs) {
                        try {
                          const val = await ti.inputValue();
                          if (!val || val.trim().length === 0) {
                            const label = await ti.evaluate(el => el.closest('label, .ia-BasePage-component, div')?.innerText || '');
                            const ans = await answerQuestion(label, [], CV, geminiKey);
                            if (ans) await ti.fill(ans);
                          }
                        } catch {}
                      }

                      const submitBtn = jobPage.locator('button:has-text("Submit your application"), button:has-text("Submit")').first();
                      if (await submitBtn.isVisible().catch(() => false)) {
                        await submitBtn.click();
                        await jobPage.waitForTimeout(3000);
                        submitted = true;
                        applyStatus = 'APPLIED';
                        log(`   🎉 Application submitted on Indeed!`);
                        break;
                      }

                      const continueBtn = jobPage.locator('button:has-text("Continue"), button:has-text("Review your application"), button:has-text("Next")').first();
                      if (await continueBtn.isVisible().catch(() => false)) {
                        await continueBtn.click();
                        await jobPage.waitForTimeout(2000);
                      } else {
                        break;
                      }
                    }
                  } else {
                    applyStatus = 'PREVIEW_DRY_RUN';
                  }
                }
              } else {
                applyStatus = 'EXTERNAL_MANUAL_REQUIRED';
                failureReason = 'Apply button not found or already applied';
              }

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
