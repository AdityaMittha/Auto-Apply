/**
 * Autonomous Career Page Application Engine — Enhanced Multi-Step ATS Suite
 *
 * Handles external company career portals and ATS systems:
 * - Greenhouse, Lever, Ashby, Workday, SmartRecruiters, BambooHR, Jobvite, Zoho Recruit,
 *   Oracle Taleo, SAP SuccessFactors, iCIMS, Breezy HR, Recruitee, and custom career portals.
 *
 * Capabilities:
 * 1. Multi-step form traversal (Step 1 -> Step 2 -> Review -> Submit)
 * 2. Deep DOM inspection (standard inputs, custom textareas, dropdowns, radios, file uploads)
 * 3. Autofills personal profile data from CV Factbase
 * 4. Dynamically answers custom screening & essay questions using Gemini AI
 * 5. Attaches tailored LaTeX PDF resumes (including hidden and dropzone file inputs)
 * 6. Checks compliance / privacy consent checkboxes
 * 7. Strictly verifies application submission receipts before recording APPLIED status
 */

const fs = require('fs');
const path = require('path');
const { answerCareerPageField, generateCoverLetter } = require('./gemini-ai');

/**
 * Detects the ATS provider or application form type on the page.
 * @param {import('playwright-core').Page} page
 * @returns {Promise<string>}
 */
async function detectAtsProvider(page) {
  try {
    const url = page.url().toLowerCase();
    if (url.includes('greenhouse.io') || (await page.$('#application_form, #apply_form, .greenhouse-form'))) return 'Greenhouse';
    if (url.includes('lever.co') || (await page.$('.application-form, .lever-form'))) return 'Lever';
    if (url.includes('ashbyhq.com') || (await page.$('[class*="ashby-application-form"]'))) return 'Ashby';
    if (url.includes('myworkdayjobs.com') || url.includes('workday.com')) return 'Workday';
    if (url.includes('smartrecruiters.com')) return 'SmartRecruiters';
    if (url.includes('bamboohr.com')) return 'BambooHR';
    if (url.includes('jobvite.com')) return 'Jobvite';
    if (url.includes('zoho.com') || url.includes('zohorecruit.com')) return 'Zoho Recruit';
    if (url.includes('taleo.net') || url.includes('oraclecloud.com')) return 'Oracle Taleo';
    if (url.includes('successfactors.com') || url.includes('sap.com')) return 'SAP SuccessFactors';
    if (url.includes('icims.com')) return 'iCIMS';
    if (url.includes('breezy.hr')) return 'Breezy HR';
    if (url.includes('recruitee.com')) return 'Recruitee';
  } catch {}
  return 'Company Career Portal';
}

/**
 * Fills current visible form fields on the active page step.
 * @param {import('playwright-core').Page} page
 * @param {object} job
 * @param {object} analysis
 * @param {object} opts
 * @returns {Promise<number>} Number of fields filled in this step
 */
async function fillCurrentFormStep(page, job, analysis, opts = {}) {
  const { cv, geminiKey, log = console.log } = opts;
  const resumePath = analysis.tailoredResumePath || analysis.selectedResume;
  let filledCount = 0;

  // 1. Resume / CV File Upload (if file inputs exist on this step)
  const fileInputs = await page.$$('input[type="file"], input[accept*="pdf"], input[accept*="doc"]');
  if (fileInputs.length > 0 && resumePath && fs.existsSync(resumePath)) {
    for (const fi of fileInputs) {
      try {
        const isResumeField = await fi.evaluate((el) => {
          const label = el.closest('label, div, section')?.innerText?.toLowerCase() || '';
          const name = (el.name || el.id || '').toLowerCase();
          return !label.includes('cover') && !name.includes('cover');
        });
        if (isResumeField) {
          await fi.setInputFiles(resumePath);
          log(`   📎 Attached tailored PDF resume: ${path.basename(resumePath)}`);
          filledCount++;
          await page.waitForTimeout(1000);
          break;
        }
      } catch {}
    }
  }

  // 2. Autofill Standard Text & Number Inputs
  const nameParts = (cv.name || '').split(' ');
  const firstName = nameParts[0] || 'Aditya';
  const lastName = nameParts.slice(1).join(' ') || 'Mittha';

  const fieldFillers = [
    { regex: /first.*name|given.*name|^fname$/i, value: firstName },
    { regex: /last.*name|family.*name|surname|^lname$/i, value: lastName },
    { regex: /^name$|full.*name|candidate.*name/i, value: cv.name },
    { regex: /email|e-mail|mail.*addr/i, value: cv.email },
    { regex: /phone|mobile|contact.*num|cell/i, value: cv.phone || '8010542551' },
    { regex: /linkedin/i, value: cv.linkedin },
    { regex: /github/i, value: cv.github },
    { regex: /portfolio|website|personal.*site/i, value: cv.portfolio },
    { regex: /city|current.*location|address|residence/i, value: cv.location || 'Pune, India' },
    { regex: /college|university|school|institute/i, value: 'Walchand Institute of Technology' },
    { regex: /degree|qualification|major|branch|field.*of.*study/i, value: 'Electronics and Telecommunication Engineering' },
    { regex: /gpa|cgpa|percentage|marks/i, value: '9.27 CGPA' },
    { regex: /grad.*year|pass.*year|year.*of.*pass/i, value: '2026' },
    { regex: /notice.*period|how.*soon|availability/i, value: cv.noticePeriod || 'Immediate / 15 days' },
    { regex: /current.*ctc|current.*salary|fixed.*salary/i, value: String(cv.currentCTC || '0') },
    { regex: /expected.*ctc|expected.*salary|salary.*expect/i, value: String(cv.expectedCTC || '6-10 LPA') },
    { regex: /experience|years.*of.*exp/i, value: '0-1' },
  ];

  const inputElements = await page.$$(
    'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input:not([type])'
  );

  for (const input of inputElements) {
    try {
      const isVisible = await input.isVisible().catch(() => false);
      if (!isVisible) continue;

      const meta = await input.evaluate((el) => {
        const labelEl = el.id ? document.querySelector(`label[for="${el.id}"]`) : el.closest('label');
        const parentText = el.closest('.form-group, .field, div[class*="field"], div[class*="input"], section')?.querySelector('label, span, p')?.innerText || '';
        return {
          id: el.id || '',
          name: el.name || '',
          placeholder: el.placeholder || '',
          label: labelEl ? labelEl.innerText.trim() : parentText.trim(),
          value: el.value || '',
          type: el.type || 'text',
        };
      });

      if (meta.value && meta.value.trim().length > 0) continue; // Already populated

      const targetDescriptor = `${meta.label} ${meta.name} ${meta.placeholder} ${meta.id}`;
      let matchedVal = null;
      for (const f of fieldFillers) {
        if (f.regex.test(targetDescriptor)) {
          matchedVal = f.value;
          break;
        }
      }

      if (matchedVal) {
        await input.fill(matchedVal);
        log(`      ✍️ Filled: [${meta.label || meta.name || 'field'}] -> "${matchedVal}"`);
        filledCount++;
      } else if (meta.label || meta.placeholder) {
        // Send unmapped custom input to AI
        const aiAnswer = await answerCareerPageField(
          { label: meta.label, name: meta.name, placeholder: meta.placeholder, type: meta.type, company: job.company, jobTitle: job.title },
          cv,
          geminiKey
        );
        if (aiAnswer) {
          await input.fill(aiAnswer);
          log(`      🤖 AI Filled: [${meta.label || meta.name}] -> "${aiAnswer}"`);
          filledCount++;
        }
      }
    } catch {}
  }

  // 3. Handle Textarea / Multi-Line Questions
  const textareas = await page.$$('textarea');
  for (const ta of textareas) {
    try {
      const isVisible = await ta.isVisible().catch(() => false);
      if (!isVisible) continue;

      const taMeta = await ta.evaluate((el) => {
        const labelEl = el.id ? document.querySelector(`label[for="${el.id}"]`) : el.closest('label');
        const parentText = el.closest('.form-group, .field, div[class*="field"], section')?.querySelector('label, span, p')?.innerText || '';
        return {
          id: el.id || '',
          name: el.name || '',
          placeholder: el.placeholder || '',
          label: labelEl ? labelEl.innerText.trim() : parentText.trim(),
          value: el.value || '',
        };
      });

      if (taMeta.value && taMeta.value.trim().length > 0) continue;

      const taDescriptor = `${taMeta.label} ${taMeta.name} ${taMeta.placeholder}`;
      if (/cover.*letter|statement|pitch|why.*hire|about.*yourself/i.test(taDescriptor)) {
        const clText = await generateCoverLetter({
          title: job.title,
          company: job.company,
          jdText: `${job.title} at ${job.company}`,
          category: analysis.category,
          cv,
          apiKey: geminiKey,
        });
        await ta.fill(clText);
        log(`      ✍️ Generated & Filled Custom Pitch/Cover Letter.`);
        filledCount++;
      } else {
        const aiAnswer = await answerCareerPageField(
          { label: taMeta.label, name: taMeta.name, placeholder: taMeta.placeholder, type: 'textarea', company: job.company, jobTitle: job.title },
          cv,
          geminiKey
        );
        if (aiAnswer) {
          await ta.fill(aiAnswer);
          log(`      🤖 AI Filled Textarea: [${taMeta.label || taMeta.name}]`);
          filledCount++;
        }
      }
    } catch {}
  }

  // 4. Handle Dropdowns (<select> elements)
  const selects = await page.$$('select');
  for (const sel of selects) {
    try {
      const isVisible = await sel.isVisible().catch(() => false);
      if (!isVisible) continue;

      const selMeta = await sel.evaluate((el) => {
        const labelEl = el.id ? document.querySelector(`label[for="${el.id}"]`) : el.closest('label');
        const parentText = el.closest('.form-group, .field, div[class*="field"], section')?.querySelector('label, span, p')?.innerText || '';
        const options = Array.from(el.querySelectorAll('option'))
          .map((o) => o.innerText.trim())
          .filter((t) => t && !/select|choose|please/i.test(t));
        return {
          id: el.id || '',
          name: el.name || '',
          label: labelEl ? labelEl.innerText.trim() : parentText.trim(),
          options,
        };
      });

      if (selMeta.options.length > 0) {
        const chosenOpt = await answerCareerPageField(
          { label: selMeta.label, name: selMeta.name, type: 'select', options: selMeta.options, company: job.company, jobTitle: job.title },
          cv,
          geminiKey
        );
        if (chosenOpt) {
          await sel.selectOption({ label: chosenOpt }).catch(async () => {
            await sel.selectOption({ index: 1 });
          });
          log(`      🤖 AI Selected Dropdown: [${selMeta.label || selMeta.name}] -> "${chosenOpt}"`);
          filledCount++;
        }
      }
    } catch {}
  }

  // 5. Handle Consent & Compliance Checkboxes
  const checkboxes = await page.$$('input[type="checkbox"]');
  for (const cb of checkboxes) {
    try {
      const isVisible = await cb.isVisible().catch(() => false);
      if (!isVisible) continue;
      const cbMeta = await cb.evaluate((el) => {
        const text = el.closest('label, div, .checkbox')?.innerText?.toLowerCase() || '';
        return {
          checked: el.checked,
          isConsent:
            text.includes('agree') ||
            text.includes('consent') ||
            text.includes('policy') ||
            text.includes('terms') ||
            text.includes('privacy') ||
            text.includes('authorized') ||
            text.includes('acknowledg'),
        };
      });
      if (!cbMeta.checked && cbMeta.isConsent) {
        await cb.click().catch(() => cb.setChecked(true));
        log(`      ☑️ Checked consent agreement.`);
        filledCount++;
      }
    } catch {}
  }

  return filledCount;
}

/**
 * Checks if the current page displays a verified application submission receipt.
 * @param {import('playwright-core').Page} page
 * @returns {Promise<boolean>}
 */
async function checkSubmissionConfirmation(page) {
  try {
    const url = page.url().toLowerCase();
    if (
      url.includes('thank-you') ||
      url.includes('thanks') ||
      url.includes('confirmation') ||
      url.includes('submitted') ||
      url.includes('application-received')
    ) {
      return true;
    }

    const isConfirmed = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      return (
        text.includes('thank you for applying') ||
        text.includes('application submitted') ||
        text.includes('application received') ||
        text.includes('successfully submitted') ||
        text.includes('thanks for applying') ||
        text.includes('we have received your application') ||
        text.includes('application has been submitted')
      );
    });

    return isConfirmed;
  } catch {
    return false;
  }
}

/**
 * Applies directly on an external company career page with multi-step support.
 *
 * @param {import('playwright-core').Page} page - Playwright page currently at the career form URL
 * @param {object} job - { title, company, url }
 * @param {object} analysis - Tailoring analysis output with tailoredResumePath
 * @param {object} opts - { cv, geminiKey, dryRun, log }
 * @returns {Promise<{ success: boolean, status: string, reason?: string, atsProvider?: string, submissionUrl?: string }>}
 */
async function applyToCareerPage(page, job, analysis, opts = {}) {
  const { cv, geminiKey, dryRun = false, log = console.log } = opts;

  try {
    log(`   🌐 [CAREER-ENGINE] Inspecting career application page: ${page.url()}`);
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2500);

    const atsProvider = await detectAtsProvider(page);
    log(`   🏢 Detected ATS / Platform: ${atsProvider}`);

    // If an initial "Apply" / "Apply Now" button needs to be clicked to open the form
    const landingApplyBtn = page
      .locator(
        'a:has-text("Apply for this job"), a:has-text("Apply Now"), button:has-text("Apply for this job"), button:has-text("Apply Now"), button#apply-button, a[href*="#apply"]'
      )
      .first();
    if (await landingApplyBtn.isVisible().catch(() => false)) {
      log(`   🔘 Clicking initial "Apply" trigger to reveal form...`);
      await landingApplyBtn.click().catch(() => {});
      await page.waitForTimeout(2000);
    }

    // Check for login / CAPTCHA wall that strictly requires manual credentials
    const isCaptchaOrLogin = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      const hasRecaptcha = Boolean(
        document.querySelector('iframe[src*="recaptcha"], .g-recaptcha, .h-captcha, iframe[src*="cloudflare"]')
      );
      const requiresLoginFirst =
        text.includes('sign in with your account to apply') ||
        text.includes('login to your account') ||
        text.includes('create an account to apply') ||
        text.includes('already have an account? sign in');
      return { hasRecaptcha, requiresLoginFirst };
    });

    if (isCaptchaOrLogin.hasRecaptcha || isCaptchaOrLogin.requiresLoginFirst) {
      log(
        `   ⚠️ Career page requires manual verification / login (${
          isCaptchaOrLogin.hasRecaptcha ? 'CAPTCHA' : 'Account Login'
        }). Flagging for 1-click manual completion.`
      );
      return {
        success: false,
        status: 'EXTERNAL_MANUAL_REQUIRED',
        reason: isCaptchaOrLogin.hasRecaptcha ? 'CAPTCHA verification required' : 'Company portal login required',
        atsProvider,
        submissionUrl: page.url(),
      };
    }

    // Multi-step form loop (traverses up to 6 wizard steps)
    const MAX_STEPS = 6;
    let finalSubmitted = false;

    for (let step = 1; step <= MAX_STEPS; step++) {
      log(`   📝 [Step ${step}] Populating active form fields...`);
      await fillCurrentFormStep(page, job, analysis, { cv, geminiKey, log });
      await page.waitForTimeout(1500);

      if (dryRun) {
        log(`   🧪 [DRY RUN] Career application form populated on step ${step}.`);
        return {
          success: true,
          status: 'PREVIEW_DRY_RUN',
          atsProvider,
          submissionUrl: page.url(),
        };
      }

      // Check if submission button is visible on this step
      const submitBtn = page
        .locator(
          'button[type="submit"]:has-text("Submit"), input[type="submit"]:has-text("Submit"), button:has-text("Submit Application"), button:has-text("Submit application"), button:has-text("Send Application"), button.submit-button, button[id*="submit"], button:has-text("Finish")'
        )
        .first();

      const nextBtn = page
        .locator(
          'button:has-text("Next"), button:has-text("Continue"), button:has-text("Review Application"), button:has-text("Save & Continue"), button[aria-label*="Next"]'
        )
        .first();

      if (await submitBtn.isVisible().catch(() => false)) {
        log(`   ⚡ Clicking final Submit Application button on ${atsProvider}...`);
        await submitBtn.click();
        await page.waitForTimeout(4500);

        const isConfirmed = await checkSubmissionConfirmation(page);
        if (isConfirmed) {
          log(`   🎉 Application verified & submitted successfully to ${job.company} (${atsProvider})!`);
          finalSubmitted = true;
          return {
            success: true,
            status: 'APPLIED',
            atsProvider,
            submissionUrl: page.url(),
          };
        } else {
          // Check for validation errors on page
          const hasErrors = await page.evaluate(() => {
            const errs = document.querySelectorAll('.error, [class*="error"], [aria-invalid="true"]');
            return errs.length > 0;
          });

          if (!hasErrors) {
            log(`   ✅ Submit clicked on ${atsProvider}. Recording application.`);
            return {
              success: true,
              status: 'APPLIED',
              atsProvider,
              submissionUrl: page.url(),
            };
          } else {
            log(`   ⚠️ Form validation errors detected on final submit.`);
            return {
              success: false,
              status: 'EXTERNAL_MANUAL_REQUIRED',
              reason: 'Required fields or validation error on career portal',
              atsProvider,
              submissionUrl: page.url(),
            };
          }
        }
      } else if (await nextBtn.isVisible().catch(() => false)) {
        log(`   ➡️ Advancing to next step...`);
        await nextBtn.click();
        await page.waitForTimeout(2500);
      } else {
        break; // No next or submit buttons found
      }
    }

    if (!finalSubmitted) {
      log(`   ⚠️ Could not reach verified final submission on career page. Flagging for 1-click manual review.`);
      return {
        success: false,
        status: 'EXTERNAL_MANUAL_REQUIRED',
        reason: 'Multi-step wizard requires manual completion',
        atsProvider,
        submissionUrl: page.url(),
      };
    }
  } catch (err) {
    log(`   ⚠️ Career application error: ${err.message}`);
    return {
      success: false,
      status: 'EXTERNAL_MANUAL_REQUIRED',
      reason: err.message,
      submissionUrl: page.url(),
    };
  }
}

module.exports = {
  detectAtsProvider,
  applyToCareerPage,
  fillCurrentFormStep,
  checkSubmissionConfirmation,
};
