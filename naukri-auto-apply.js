/**
 * Naukri Auto Apply Engine — Searches for jobs/internships matching your profile,
 * fetches Job Descriptions, analyzes & selects tailored resume PDFs, answers
 * screening questions, and submits applications automatically.
 */
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { CV, CREDS, geminiKey, autoApplyConfig } = require('./config');
const { analyzeJob, answerQuestion } = require('./tailor-engine');

const PROFILE_DIR = path.join(__dirname, '.naukri-chrome-profile');
const APPLIED_FILE = path.join(__dirname, 'applied-jobs.json');
const LOG_FILE = path.join(__dirname, 'naukri-applications.log');

const IS_DRY_RUN = process.argv.includes('--dry-run') || process.argv.includes('dry') || autoApplyConfig.dryRun;
const VISIBLE_MODE = process.argv.includes('visible') || process.argv.includes('--visible');

const log = (msg) => {
  const line = `[${new Date().toLocaleString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
};

function loadAppliedJobs() {
  try {
    if (fs.existsSync(APPLIED_FILE)) {
      return JSON.parse(fs.readFileSync(APPLIED_FILE, 'utf8'));
    }
  } catch (e) {
    // fallback
  }
  return { applied: [], lastUpdated: null };
}

function saveAppliedJobs(data) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(APPLIED_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  log(`=======================================================`);
  log(`🚀 Starting Naukri Auto-Apply Engine (Dry Run: ${IS_DRY_RUN ? 'YES' : 'NO'}, Mode: ${VISIBLE_MODE ? 'Visible' : 'Off-screen'})`);
  log(`🎯 Target Keywords: ${autoApplyConfig.keywords.join(', ')}`);
  log(`📍 Target Locations: ${autoApplyConfig.locations.join(', ')}`);
  log(`📊 Minimum Match Score: ${autoApplyConfig.minMatchScore}% | Max Applications: ${autoApplyConfig.maxPerRun}`);
  log(`=======================================================`);

  const appliedDb = loadAppliedJobs();
  const appliedUrls = new Set(appliedDb.applied.map(a => a.url));
  const appliedJobIds = new Set(appliedDb.applied.map(a => a.jobId));

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
  let totalAppliedThisRun = 0;
  let totalEvaluated = 0;

  try {
    // Navigate to homepage first to confirm login session
    await page.goto('https://www.naukri.com/mnjuser/profile', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);

    for (const keyword of autoApplyConfig.keywords) {
      if (totalAppliedThisRun >= autoApplyConfig.maxPerRun) break;

      for (const location of autoApplyConfig.locations) {
        if (totalAppliedThisRun >= autoApplyConfig.maxPerRun) break;

        const slugKeyword = encodeURIComponent(keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
        const slugLoc = encodeURIComponent(location.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
        const searchUrl = `https://www.naukri.com/${slugKeyword}-jobs-in-${slugLoc}?experience=${autoApplyConfig.experience}`;

        log(`\n🔍 Searching: "${keyword}" in "${location}" -> ${searchUrl}`);

        try {
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.waitForTimeout(3000);

          // Find job cards
          const jobCards = await page.evaluate(() => {
            const cards = Array.from(document.querySelectorAll('article.jobTuple, div.srp-jobtuple-wrapper, div.cust-job-tuple'));
            return cards.map(c => {
              const titleEl = c.querySelector('a.title, a[class*="title"]');
              const compEl = c.querySelector('a.comp-name, a.subTitle, a[class*="comp-name"]');
              const expEl = c.querySelector('span.expwdth, span[class*="exp"]');
              const locEl = c.querySelector('span.locWdth, span[class*="loc"]');
              const descEl = c.querySelector('span.job-desc, div.job-description, div.row6');
              const tagEls = Array.from(c.querySelectorAll('ul.tags-gt li, ul[class*="tags"] li, [class*="tag"]'));
              const jobId = c.getAttribute('data-job-id') || c.getAttribute('id') || (titleEl ? titleEl.href : '');

              return {
                jobId,
                title: titleEl ? titleEl.innerText.trim() : '',
                url: titleEl ? titleEl.href : '',
                company: compEl ? compEl.innerText.trim() : '',
                experience: expEl ? expEl.innerText.trim() : '',
                location: locEl ? locEl.innerText.trim() : '',
                snippet: descEl ? descEl.innerText.trim() : '',
                tags: tagEls.map(t => t.innerText.trim()).filter(Boolean),
              };
            }).filter(j => j.title && j.url);
          });

          log(`Found ${jobCards.length} listings on page.`);

          for (const job of jobCards) {
            if (totalAppliedThisRun >= autoApplyConfig.maxPerRun) break;
            if (appliedUrls.has(job.url) || appliedJobIds.has(job.jobId)) {
              continue; // Already applied/evaluated
            }

            totalEvaluated++;
            log(`-------------------------------------------------------`);
            log(`[#${totalEvaluated}] Evaluating: ${job.title} | Company: ${job.company} | Loc: ${job.location}`);

            // Fetch full JD by opening job URL in a new tab
            let fullJd = job.snippet;
            let jobPage = null;
            try {
              jobPage = await ctx.newPage();
              await jobPage.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
              await jobPage.waitForTimeout(2000);

              const pageJd = await jobPage.evaluate(() => {
                const jdContainer = document.querySelector('section.job-desc-section, div.dang-inner-html, div[class*="job-desc"]');
                return jdContainer ? jdContainer.innerText.trim() : '';
              });
              if (pageJd) fullJd = pageJd;
            } catch (err) {
              log(`Warning: Could not fetch detailed JD page, using card snippet.`);
            }

            // Run Tailoring Engine
            const analysis = analyzeJob(job.title, fullJd, job.tags);
            log(`   Category: [${analysis.category.toUpperCase()}] | Score: ${analysis.matchScore}% (Min: ${autoApplyConfig.minMatchScore}%)`);
            log(`   Matched Keywords: ${analysis.matchedKeywords.slice(0, 6).join(', ')}`);
            log(`   Selected Resume: ${analysis.resumeName}`);

            if (analysis.matchScore < autoApplyConfig.minMatchScore) {
              log(`   ⏭️ Skipped: Match score (${analysis.matchScore}%) below threshold.`);
              if (jobPage) await jobPage.close().catch(() => {});
              continue;
            }

            // Check Application Type (Direct Apply vs External Site)
            if (jobPage) {
              const isExternal = await jobPage.evaluate(() => {
                const btn = document.querySelector('#apply-button, button.apply-button, button[class*="apply"]');
                return btn && /company site|external/i.test(btn.innerText);
              });

              if (isExternal) {
                log(`   ℹ️ External Job (Redirects to company portal). Saved to applied tracking.`);
                appliedDb.applied.push({
                  jobId: job.jobId,
                  title: job.title,
                  company: job.company,
                  url: job.url,
                  category: analysis.category,
                  resumeUsed: analysis.resumeName,
                  matchScore: analysis.matchScore,
                  appliedAt: new Date().toISOString(),
                  status: 'EXTERNAL_REDIRECT',
                });
                appliedUrls.add(job.url);
                saveAppliedJobs(appliedDb);
                await jobPage.close().catch(() => {});
                continue;
              }

              if (IS_DRY_RUN) {
                log(`   🧪 [DRY RUN] Would apply using "${analysis.resumeName}" with answers: CTC=${CV.expectedSalary}, Notice=${CV.noticePeriod}`);
                appliedDb.applied.push({
                  jobId: job.jobId,
                  title: job.title,
                  company: job.company,
                  portal: 'Naukri',
                  url: job.url,
                  category: analysis.category,
                  resumeUsed: analysis.resumeName,
                  matchScore: analysis.matchScore,
                  appliedAt: new Date().toISOString(),
                  status: 'PREVIEW_DRY_RUN',
                });
                appliedUrls.add(job.url);
                saveAppliedJobs(appliedDb);
                totalAppliedThisRun++;
                await jobPage.close().catch(() => {});
                continue;
              }

              // LIVE APPLY FLOW
              log(`   ⚡ Submitting application...`);
              const applyBtn = jobPage.locator('#apply-button, button.apply-button, button:has-text("Apply")').first();
              if (await applyBtn.isVisible().catch(() => false)) {
                await applyBtn.click();
                await jobPage.waitForTimeout(3000);

                // Handle potential chatbot / questionnaire modal
                const chatbotModal = jobPage.locator('.bot-drawer, .chat-wrapper, .modal-content, [class*="chatbot"]');
                if (await chatbotModal.isVisible().catch(() => false)) {
                  log(`   🤖 Questionnaire modal detected — answering screening questions...`);

                  // Loop through questions if chatbot appears
                  for (let qStep = 0; qStep < 5; qStep++) {
                    const questionText = await jobPage.evaluate(() => {
                      const qEl = document.querySelector('.bot-question, [class*="bot-msg"], .question-text');
                      return qEl ? qEl.innerText.trim() : '';
                    });

                    const options = await jobPage.evaluate(() => {
                      const optButtons = Array.from(document.querySelectorAll('.bot-option, .chip, button.choice-btn'));
                      return optButtons.map(b => b.innerText.trim()).filter(Boolean);
                    });

                    const answer = await answerQuestion(questionText, options, CV, geminiKey);
                    log(`      Q: "${questionText.slice(0, 50)}..." -> Answer: "${answer}"`);

                    // Try clicking matching option chip or typing into input
                    const chipBtn = jobPage.locator(`button:has-text("${answer}"), .chip:has-text("${answer}")`).first();
                    if (await chipBtn.isVisible().catch(() => false)) {
                      await chipBtn.click();
                    } else {
                      const chatInput = jobPage.locator('input[type="text"], textarea').first();
                      if (await chatInput.isVisible().catch(() => false)) {
                        await chatInput.fill(answer);
                        await jobPage.keyboard.press('Enter');
                      }
                    }
                    await jobPage.waitForTimeout(2000);
                  }
                }

                // Check for tailored resume upload prompt
                const fileInput = jobPage.locator('input[type="file"]').first();
                if (await fileInput.isVisible().catch(() => false)) {
                  log(`   📄 Attaching tailored resume: ${analysis.resumeName}`);
                  await fileInput.setInputFiles(analysis.selectedResume);
                  await jobPage.waitForTimeout(2000);
                }

                // Final Submit button if present
                const submitBtn = jobPage.locator('button:has-text("Submit"), button:has-text("Save & Apply"), button.submit-btn').first();
                if (await submitBtn.isVisible().catch(() => false)) {
                  await submitBtn.click();
                  await jobPage.waitForTimeout(3000);
                }

                log(`   ✅ Applied Successfully to ${job.title} at ${job.company}!`);
                totalAppliedThisRun++;

                appliedDb.applied.push({
                  jobId: job.jobId,
                  title: job.title,
                  company: job.company,
                  portal: 'Naukri',
                  url: job.url,
                  category: analysis.category,
                  resumeUsed: analysis.resumeName,
                  matchScore: analysis.matchScore,
                  appliedAt: new Date().toISOString(),
                  status: 'APPLIED',
                });
                appliedUrls.add(job.url);
                saveAppliedJobs(appliedDb);

                // Anti-bot human delay
                const delaySec = Math.floor(Math.random() * 6) + 6;
                log(`   ⏳ Pacing: Waiting ${delaySec}s before next application...`);
                await sleep(delaySec * 1000);
              } else {
                log(`   ⚠️ Apply button not clickable or already applied.`);
              }
            }

            if (jobPage) await jobPage.close().catch(() => {});
          }
        } catch (searchErr) {
          log(`Error searching "${keyword}" in "${location}": ${searchErr.message}`);
        }
      }
    }

    log(`\n=======================================================`);
    log(`🎉 Auto-Apply Run Finished!`);
    log(`📊 Evaluated: ${totalEvaluated} jobs | Applied/Processed: ${totalAppliedThisRun} jobs`);
    log(`📁 History stored in: ${APPLIED_FILE}`);
    log(`=======================================================`);

  } catch (err) {
    log(`Fatal Error in Auto-Apply: ${err.message}`);
  } finally {
    await ctx.close();
  }
})();
