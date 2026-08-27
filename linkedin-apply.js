/**
 * LinkedIn Easy Apply & Dynamic Resume Tailoring Engine
 * 
 * Searches matching Easy Apply roles in Pune/Remote, generates customized resumes,
 * fills Easy Apply modals with PDF uploads, answers screening prompts, and submits applications.
 */

const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { autoApplyConfig, CV, geminiKey, aiConfig, isLocationAllowed, getEffectiveMinScore } = require('./config');
const { analyzeJob, answerQuestion } = require('./tailor-engine');
const { applyToCareerPage } = require('./career-page-engine');

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
    // 1. Check Login State
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);

    let isLoggedIn = await page.evaluate(() => {
      return !document.querySelector('a[href*="/login"], a[href*="/signup"], .join-now') &&
             Boolean(document.querySelector('.global-nav__me, .feed-identity-module, #global-nav, [data-control-name="identity_profile_photo"], img[alt*="Photo of"]'));
    });

    if (!isLoggedIn || IS_LOGIN_MODE) {
      log(`🔑 Launching LinkedIn login flow...`);
      await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2000);

      // 1. Check for "Continue with Google" button
      const googleBtn = page.locator('button:has-text("Continue with Google"), a:has-text("Continue with Google"), [data-tracking-control-name*="google"]').first();
      if (await googleBtn.isVisible().catch(() => false)) {
        await googleBtn.click();
        log(`   Clicked "Continue with Google"...`);

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
      } else {
        // Fallback: fill LinkedIn email & password
        const userField = page.locator('input#username, input[name="session_key"]').first();
        const passField = page.locator('input#password, input[name="session_password"]').first();
        if (await userField.isVisible().catch(() => false)) {
          log(`   Auto-filling email: ${CREDS.email}`);
          await userField.fill(CREDS.email);
          if (await passField.isVisible().catch(() => false)) {
            await passField.fill(CREDS.password);
          }
          const submitBtn = page.locator('button[type="submit"]:has-text("Sign in")').first();
          if (await submitBtn.isVisible().catch(() => false)) {
            await submitBtn.click();
          }
        }
      }

      log(`   ⏳ Waiting for LinkedIn feed verification (complete any verification if prompted)...`);
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        const pages = ctx.pages();
        const authed = pages.find(p => /linkedin\.com\/feed/i.test(p.url()));
        if (authed) {
          isLoggedIn = true;
          break;
        }
        isLoggedIn = await page.evaluate(() => {
          return Boolean(document.querySelector('.global-nav__me, .feed-identity-module, #global-nav'));
        }).catch(() => false);
        if (isLoggedIn) break;
        await page.waitForTimeout(2000);
      }

      if (isLoggedIn) {
        log(`🎉 Successfully logged into LinkedIn! Session saved in .linkedin-chrome-profile.`);
        if (IS_LOGIN_MODE) {
          log(`✅ Login complete. You can now run "npm run apply:linkedin" or "npm run apply:all".`);
          return;
        }
      } else {
        log(`⚠️ LinkedIn login did not complete within the timeout.`);
        if (IS_LOGIN_MODE) {
          await page.waitForTimeout(30000);
          return;
        }
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

            const effectiveMin = getEffectiveMinScore(job.title, fullJd, analysis.category);
            log(`   Category: [${analysis.category.toUpperCase()}] | Score: ${analysis.matchScore}% (Min: ${effectiveMin}%) | Resume: ${analysis.resumeName}`);

            if (analysis.matchScore < effectiveMin) {
              log(`   ⏭️ Skipped: Match score (${analysis.matchScore}%) below threshold (${effectiveMin}%).`);
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
                  status: 'PREVIEW_DRY_RUN',
                });
                appliedUrls.add(job.url);
                saveAppliedJobs(appliedDb);
                processedCount++;
                await jobPage.close().catch(() => {});
                continue;
              }

              // LIVE APPLY FLOW
              log(`   ⚡ Launching LinkedIn application flow...`);
              const easyApplyBtn = jobPage.locator('button.jobs-apply-button, button:has-text("Easy Apply")').first();
              const externalApplyBtn = jobPage.locator('button:has-text("Apply"), a:has-text("Apply")').first();

              let applyStatus = 'APPLIED';
              let externalUrl = job.url;
              let portalName = 'LinkedIn';
              let failureReason = null;

              if (await easyApplyBtn.isVisible().catch(() => false)) {
                await easyApplyBtn.click();
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

                  // Answer any text inputs / textareas in this modal step
                  const textInputs = await jobPage.$$('.jobs-easy-apply-modal input[type="text"]:visible, .jobs-easy-apply-modal textarea:visible');
                  for (const ti of textInputs) {
                    try {
                      const val = await ti.inputValue();
                      if (!val || val.trim().length === 0) {
                        const label = await ti.evaluate(el => el.closest('.fb-dash-form-element, div')?.querySelector('label, span')?.innerText || '');
                        const ans = await answerQuestion(label, [], CV, geminiKey);
                        if (ans) await ti.fill(ans);
                      }
                    } catch {}
                  }

                  // Answer any dropdowns in this modal step
                  const selects = await jobPage.$$('.jobs-easy-apply-modal select:visible');
                  for (const sel of selects) {
                    try {
                      const selVal = await sel.inputValue();
                      if (!selVal || selVal === 'Select an option') {
                        await sel.selectOption({ index: 1 });
                      }
                    } catch {}
                  }

                  // Check for Submit button
                  const submitBtn = jobPage.locator('button:has-text("Submit application"), button[aria-label*="Submit application"]').first();
                  if (await submitBtn.isVisible().catch(() => false)) {
                    await submitBtn.click();
                    await jobPage.waitForTimeout(3000);
                    submitted = true;
                    applyStatus = 'APPLIED';
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

                if (!submitted) {
                  applyStatus = 'EXTERNAL_MANUAL_REQUIRED';
                  failureReason = 'Easy Apply modal could not reach final submit';
                }
              } else if (await externalApplyBtn.isVisible().catch(() => false)) {
                log(`   ℹ️ External Job (Redirects to company portal). Triggering AI Career Page Engine...`);
                let externalPage = null;
                try {
                  const popupPromise = ctx.waitForEvent('page', { timeout: 10000 }).catch(() => null);
                  await externalApplyBtn.click();
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
                  portalName = `LinkedIn (${extRes.atsProvider || 'Company Site'})`;
                  failureReason = extRes.reason || null;
                } catch (extErr) {
                  log(`   ⚠️ External apply failed: ${extErr.message}`);
                  applyStatus = 'EXTERNAL_MANUAL_REQUIRED';
                  failureReason = extErr.message;
                } finally {
                  if (externalPage && externalPage !== jobPage) await externalPage.close().catch(() => {});
                }
              } else {
                applyStatus = 'EXTERNAL_MANUAL_REQUIRED';
                failureReason = 'Apply button not found';
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
