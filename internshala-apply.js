/**
 * Internshala Live Application & Dynamic Resume Tailoring Engine
 * 
 * Searches matching internships, generates anti-AI humanized cover letters & tailored resumes,
 * fills assessments, attaches PDFs, and submits real applications.
 */

const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { autoApplyConfig, CV, geminiKey, aiConfig, isLocationAllowed, getEffectiveMinScore } = require('./config');
const { analyzeJob, answerQuestion } = require('./tailor-engine');
const { generateCoverLetter } = require('./gemini-ai');
const { applyToCareerPage } = require('./career-page-engine');

const PROFILE_DIR = path.join(__dirname, '.internshala-chrome-profile');
const LOG_FILE = path.join(__dirname, 'naukri-applications.log');
const APPLIED_FILE = path.join(__dirname, 'applied-jobs.json');
const IS_DRY_RUN = process.argv.includes('dry') || process.argv.includes('--dry-run') || autoApplyConfig.dryRun;
const VISIBLE_MODE = process.argv.includes('visible') || process.argv.includes('--visible') || process.argv.includes('login');

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
  'python-internship',
  'electronics-internship',
  'firmware-internship',
];

(async () => {
  log(`=======================================================`);
  log(`🚀 Starting Internshala Live Application Engine`);
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
    // 1. Verify Login State
    await page.goto('https://internshala.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);

    let isLoggedIn = await page.evaluate(() => {
      return Boolean(document.querySelector('.profile_container, .user_profile, #profile_dropdown, a[href*="/student/dashboard"]'));
    });

    if (!isLoggedIn || IS_LOGIN_MODE) {
      log(`🔑 Launching Internshala Google sign-in flow...`);
      await page.goto('https://internshala.com/login/user', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2000);

      // Click "Sign in with Google" button
      const googleBtn = page.locator('#google_login, a.google_btn, .google-login, button:has-text("Sign in with Google"), a:has-text("Sign in with Google"), [href*="google"]').first();
      if (await googleBtn.isVisible().catch(() => false)) {
        await googleBtn.click();
        log(`   Clicked "Sign in with Google"...`);

        // Find Google popup or redirected tab
        let g = null;
        for (let i = 0; i < 20 && !g; i++) {
          await page.waitForTimeout(1000);
          g = ctx.pages().find((p) => /accounts\.google\./.test(p.url())) || null;
        }

        if (g) {
          await g.waitForLoadState('domcontentloaded').catch(() => {});
          const knownAccount = g.locator(`[data-email="${CREDS.email}"]`).first();
          if (await knownAccount.isVisible().catch(() => false)) {
            log(`   Selecting known Google account: ${CREDS.email}`);
            await knownAccount.click();
          } else {
            const emailBox = g.locator('input#identifierId, input[type="email"]').first();
            if (await emailBox.isVisible().catch(() => false)) {
              log(`   Filling email: ${CREDS.email}`);
              await emailBox.fill(CREDS.email);
              await g.locator('#identifierNext, button:has-text("Next")').first().click();
              await g.waitForTimeout(2000);
              const passBox = g.locator('input[type="password"]').first();
              if (await passBox.isVisible().catch(() => false)) {
                log(`   Filling password...`);
                await passBox.fill(CREDS.password);
                await g.locator('#passwordNext, button:has-text("Next")').first().click();
              }
            }
          }
        }
      }

      // Wait for login completion / dashboard redirect (up to 90 seconds for 2FA if needed)
      log(`   ⏳ Waiting for dashboard confirmation...`);
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        const pages = ctx.pages();
        const authed = pages.find(p => /internshala\.com\/(student\/dashboard|internships)/i.test(p.url()));
        if (authed) {
          isLoggedIn = true;
          break;
        }
        isLoggedIn = await page.evaluate(() => {
          return Boolean(document.querySelector('.profile_container, .user_profile, #profile_dropdown, a[href*="/student/dashboard"]'));
        }).catch(() => false);
        if (isLoggedIn) break;
        await page.waitForTimeout(2000);
      }

      if (isLoggedIn) {
        log(`🎉 Successfully logged into Internshala! Session saved in .internshala-chrome-profile.`);
        if (IS_LOGIN_MODE) {
          log(`✅ Login complete. You can now run "npm run apply:internshala" or "npm run apply:all".`);
          return;
        }
      } else {
        log(`⚠️ Google login did not complete within the timeout. Please complete sign-in in the open browser.`);
        if (IS_LOGIN_MODE) {
          await page.waitForTimeout(30000);
          return;
        }
      }
    } else {
      log(`✅ Authenticated on Internshala.`);
    }

    // 2. Search & Apply Loop
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

          // Fetch full JD from detail page
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

          // Run Hybrid Tailoring Engine & compile custom LaTeX PDF
            const analysis = await analyzeJob(item.title, fullJd, [], {
            cv: CV,
            geminiKey,
            aiEnabled: aiConfig.enabled,
            jobId: item.url || `${item.company}_${item.title}`,
          });

          const effectiveMin = getEffectiveMinScore(item.title, fullJd, analysis.category);
          log(`   Category: [${analysis.category.toUpperCase()}] | Score: ${analysis.matchScore}% (Min: ${effectiveMin}%) | Resume: ${analysis.resumeName}`);

          if (analysis.matchScore < effectiveMin) {
            log(`   ⏭️ Skipped: Match score (${analysis.matchScore}%) below threshold (${effectiveMin}%).`);
            if (detailPage) await detailPage.close().catch(() => {});
            continue;
          }

          // Check for already applied on page
          if (detailPage) {
            const alreadyApplied = await detailPage.evaluate(() => {
              const btn = document.querySelector('#already_applied, .already_applied, button:disabled');
              return Boolean(btn && /applied/i.test(btn.innerText));
            });

            if (alreadyApplied) {
              log(`   ℹ️ Already applied previously on Internshala.`);
              appliedUrls.add(item.url);
              await detailPage.close().catch(() => {});
              continue;
            }

            if (IS_DRY_RUN) {
              log(`   🧪 [DRY RUN] Would click Apply & submit tailored cover letter + ${analysis.resumeName}`);
              appliedDb.applied.push({
                jobId: item.url,
                title: item.title,
                company: item.company,
                portal: 'Internshala',
                url: item.url,
                location: item.location,
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
              appliedUrls.add(item.url);
              saveAppliedJobs(appliedDb);
              processedCount++;
              await detailPage.close().catch(() => {});
              continue;
            }

            // LIVE APPLY FLOW
            log(`   ⚡ Opening application modal...`);
            const applyBtn = detailPage.locator('#apply_now_button, button.btn-large:has-text("Apply"), button:has-text("Apply now")').first();
            if (await applyBtn.isVisible().catch(() => false)) {
              await applyBtn.click();
              await detailPage.waitForTimeout(3000);

              // 1. Generate Cover Letter Pitch
              log(`   ✍️ Generating tailored cover letter with Gemini AI...`);
              const coverLetterText = await generateCoverLetter({
                title: item.title,
                company: item.company,
                jdText: fullJd,
                category: analysis.category,
                cv: CV,
                apiKey: geminiKey,
              }) || `I am a final-year Electronics and Telecommunication Engineering student at Walchand Institute of Technology (9.27 CGPA) with hands-on experience in Embedded C, FreeRTOS, ESP32, and Python systems. I am eager to contribute effectively to ${item.company} and am available immediately in Pune / Remote.`;

              // 2. Fill Cover Letter Textarea / Quill Editor
              const coverTextarea = detailPage.locator('#cover_letter, textarea[name="cover_letter"], textarea[placeholder*="cover letter"], div.ql-editor').first();
              if (await coverTextarea.isVisible().catch(() => false)) {
                try {
                  await coverTextarea.fill(coverLetterText);
                } catch {
                  await coverTextarea.evaluate((el, text) => {
                    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') el.value = text;
                    else el.innerText = text;
                  }, coverLetterText);
                }
                log(`   ✅ Cover letter filled (${coverLetterText.slice(0, 50)}...)`);
              }

              // 3. Answer Custom Assessment Questions if present
              const assessmentInputs = await detailPage.locator('textarea[name*="assessment"], textarea[id*="assessment"], input[type="text"][name*="answer"]').all();
              for (let aIdx = 0; aIdx < assessmentInputs.length; aIdx++) {
                const input = assessmentInputs[aIdx];
                if (await input.isVisible().catch(() => false)) {
                  const qLabel = await input.evaluate(el => {
                    const label = el.closest('.form-group, .question-container')?.querySelector('label, .question-text');
                    return label ? label.innerText.trim() : 'Assessment Question';
                  });
                  const answer = await answerQuestion(qLabel, [], CV, geminiKey);
                  await input.fill(answer);
                  log(`   📝 Answered question: "${qLabel.slice(0, 40)}..." → ${answer.slice(0, 40)}`);
                }
              }

              // 4. Attach Tailored PDF Resume if file input is available
              const fileInput = detailPage.locator('input[type="file"]').first();
              if (await fileInput.isVisible().catch(() => false) && analysis.tailoredResumePath && fs.existsSync(analysis.tailoredResumePath)) {
                await fileInput.setInputFiles(analysis.tailoredResumePath);
                log(`   📎 Attached tailored PDF: ${path.basename(analysis.tailoredResumePath)}`);
              }

              // 5. Submit Application
              const submitBtn = detailPage.locator('input#submit, button#submit, button:has-text("Submit application"), button:has-text("Submit")').first();
              let isSubmitted = false;
              let failureReason = null;
              let applyStatus = 'APPLIED';
              let portalName = 'Internshala';

              if (await submitBtn.isVisible().catch(() => false)) {
                await submitBtn.click();
                await detailPage.waitForTimeout(4000);
                isSubmitted = true;
                log(`   🎉 Application submitted successfully on Internshala!`);
              } else {
                // Check if external link exists on Internshala
                const extLink = detailPage.locator('a[href*="http"]:has-text("Apply"), a.btn:has-text("Apply")').first();
                if (await extLink.isVisible().catch(() => false)) {
                  log(`   ℹ️ Internshala external link detected. Triggering AI Career Page Engine...`);
                  try {
                    const popupPromise = ctx.waitForEvent('page', { timeout: 10000 }).catch(() => null);
                    await extLink.click();
                    let extPage = await popupPromise;
                    if (!extPage) extPage = detailPage;

                    const extRes = await applyToCareerPage(extPage, item, analysis, {
                      cv: CV,
                      geminiKey,
                      dryRun: IS_DRY_RUN,
                      log,
                    });
                    applyStatus = extRes.status || 'APPLIED';
                    portalName = `Internshala (${extRes.atsProvider || 'Company Site'})`;
                    failureReason = extRes.reason || null;
                    if (applyStatus === 'APPLIED') isSubmitted = true;
                    if (extPage && extPage !== detailPage) await extPage.close().catch(() => {});
                  } catch (extErr) {
                    failureReason = extErr.message;
                    applyStatus = 'EXTERNAL_MANUAL_REQUIRED';
                  }
                } else {
                  failureReason = 'Submit button not found';
                  applyStatus = 'EXTERNAL_MANUAL_REQUIRED';
                }
              }

              appliedDb.applied.push({
                jobId: item.url,
                title: item.title,
                company: item.company,
                portal: portalName,
                url: item.url,
                location: item.location,
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

              appliedUrls.add(item.url);
              saveAppliedJobs(appliedDb);
              if (applyStatus === 'APPLIED' || applyStatus === 'PREVIEW_DRY_RUN') {
                processedCount++;
              }
            } else {
              log(`   ⚠️ Apply button not accessible on detail page.`);
            }

            await detailPage.close().catch(() => {});
          }
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
