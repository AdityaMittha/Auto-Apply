/**
 * Recruiter Cold Outreach Mailer
 * 
 * Automatically sends tailored, highly professional and concise cold outreach emails
 * to HRs/Recruiters whose email addresses were discovered during job searches or status tracking.
 * Attaches the candidate's tailored resume for the specific role.
 */

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { CV } = require('./config');
const { callGemini } = require('./gemini-ai');

const APPLIED_FILE = path.join(__dirname, 'applied-jobs.json');
const LOG_FILE = path.join(__dirname, 'naukri-applications.log');
const RESUME_DIR = path.join(__dirname, 'resume');
const TAILORED_DIR = path.join(RESUME_DIR, 'tailored');

const IS_DRY_RUN = process.argv.includes('--dry-run') || process.argv.includes('dry');

const log = (msg) => {
  const line = `[${new Date().toLocaleString()}] [COLD_MAILER] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
};

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  const out = {};
  if (!fs.existsSync(envPath)) return out;
  for (const line of fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const E = loadEnv();
const SMTP_USER = E.SMTP_USER || E.GOOGLE_EMAIL || 'adityamittha09@gmail.com';
const SMTP_PASS = E.SMTP_PASS || '';
const GEMINI_KEY = E.GEMINI_API_KEY || '';
const MAX_PER_DAY = parseInt(E.COLD_EMAIL_MAX_PER_DAY || '10', 10);
const COLD_EMAIL_ENABLED = (E.COLD_EMAIL_ENABLED || 'true').toLowerCase() === 'true';

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

/**
 * Finds the resume path to attach for a specific application.
 */
function getResumePathForJob(job) {
  if (job.tailoredResumePath && fs.existsSync(job.tailoredResumePath)) {
    return job.tailoredResumePath;
  }
  if (job.resumeUsed) {
    const directPath = path.join(RESUME_DIR, job.resumeUsed);
    if (fs.existsSync(directPath)) return directPath;
    const tailoredPath = path.join(TAILORED_DIR, job.resumeUsed);
    if (fs.existsSync(tailoredPath)) return tailoredPath;
  }
  const defaultEmbed = path.join(RESUME_DIR, 'Mittha_Aditya_Embedded.pdf');
  return fs.existsSync(defaultEmbed) ? defaultEmbed : null;
}

/**
 * Generates a concise, formal cold outreach email using Gemini AI or template fallback.
 */
async function generateColdEmailContent(job) {
  const roleTitle = job.title || 'the open position';
  const company = job.company || 'your organization';
  const recruiter = job.recruiterName || 'Hiring Team';

  if (GEMINI_KEY) {
    const prompt = `Write a short, professional, and formal cold email from Aditya Mittha to a recruiter (${recruiter}) regarding the "${roleTitle}" position at "${company}".
Candidate Profile:
- Final-year B.Tech in Electronics & Telecommunication at Walchand Institute of Technology (CGPA 9.27)
- Practical experience in Embedded C, Python, ESP32, FreeRTOS, IoT and Cloud integration
- Recently applied to the role on portal and sharing the tailored resume directly

Style constraints:
- Formal, respectful, and concise (strictly 3-4 sentences total)
- Return JSON ONLY with keys "subject" and "body"
Example format:
{
  "subject": "Application for [Role] - Aditya Mittha",
  "body": "Dear [Recruiter],\\n\\nI recently submitted my application for the [Role] at [Company]..."
}`;

    try {
      const raw = await callGemini(prompt, GEMINI_KEY, { maxTokens: 400, temperature: 0.2 });
      if (raw) {
        const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
        const parsed = JSON.parse(cleaned);
        if (parsed.subject && parsed.body) return parsed;
      }
    } catch {}
  }

  // High quality formal template fallback
  return {
    subject: `Application for ${roleTitle} — Aditya Mittha`,
    body: `Dear ${recruiter},\n\nI recently applied for the ${roleTitle} position at ${company} and wanted to briefly share my resume directly. I am a final-year E&TC engineering student (9.27 CGPA) at Walchand with hands-on experience in Embedded Systems, Python, and IoT development.\n\nI have attached my tailored resume for your review and would welcome the opportunity to discuss how my background aligns with your team's goals.\n\nBest regards,\nAditya Mittha\n+91 8010542551 | Solapur / Pune\nLinkedIn: linkedin.com/in/adityamittha | GitHub: github.com/AdityaMittha`,
  };
}

/**
 * Sends cold emails to pending recruiters with rate limiting.
 */
async function sendColdEmails() {
  log(`=======================================================`);
  log(`✉️  Starting Recruiter Cold Outreach Engine`);
  log(`🎯 Max per run: ${MAX_PER_DAY} | Dry Run: ${IS_DRY_RUN ? 'YES' : 'NO'}`);
  log(`=======================================================`);

  if (!COLD_EMAIL_ENABLED) {
    log(`ℹ️ Cold emailing is disabled in config (COLD_EMAIL_ENABLED=false).`);
    return;
  }

  const db = loadAppliedJobs();
  const eligible = db.applied.filter(j => 
    j.recruiterEmail &&
    !j.coldEmailed &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(j.recruiterEmail)
  );

  log(`Found ${eligible.length} application(s) with recruiter emails ready for outreach.`);

  if (eligible.length === 0) {
    log(`No pending recruiter emails found.`);
    return;
  }

  let transporter = null;
  if (!IS_DRY_RUN) {
    if (!SMTP_PASS) {
      log(`⚠️ SMTP_PASS is missing. Cannot send cold emails.`);
      return;
    }
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
      },
    });
  }

  let sentCount = 0;

  for (const job of eligible) {
    if (sentCount >= MAX_PER_DAY) {
      log(`Reached daily cold email limit (${MAX_PER_DAY}). Stopping.`);
      break;
    }

    const resumePath = getResumePathForJob(job);
    const emailContent = await generateColdEmailContent(job);

    log(`-------------------------------------------------------`);
    log(`Preparing email for ${job.recruiterEmail} (${job.company} - ${job.title})`);
    log(`Subject: ${emailContent.subject}`);
    log(`Resume: ${resumePath ? path.basename(resumePath) : 'None'}`);

    if (IS_DRY_RUN) {
      log(`[DRY RUN] Would send to ${job.recruiterEmail}:\n${emailContent.body}`);
      sentCount++;
      continue;
    }

    const mailOptions = {
      from: `"Aditya Mittha" <${SMTP_USER}>`,
      to: job.recruiterEmail,
      subject: emailContent.subject,
      text: emailContent.body,
      attachments: resumePath ? [
        {
          filename: `Aditya_Mittha_Resume_${(job.category || 'Embedded')}.pdf`,
          path: resumePath,
          contentType: 'application/pdf',
        }
      ] : [],
    };

    try {
      const info = await transporter.sendMail(mailOptions);
      log(`✅ Cold email sent successfully to ${job.recruiterEmail} (MessageId: ${info.messageId})`);
      job.coldEmailed = true;
      job.coldEmailedAt = new Date().toISOString();
      job.coldEmailSubject = emailContent.subject;
      job.coldEmailBody = emailContent.body;
      job.coldEmailRecipient = job.recruiterEmail;
      job.status = job.status && !job.status.includes('COLD_EMAILED') ? `${job.status}` : (job.status || 'COLD_EMAILED');
      sentCount++;
      saveAppliedJobs(db);

      // 5-second sleep between cold emails to prevent SMTP rate limits
      await new Promise(r => setTimeout(r, 5000));
    } catch (err) {
      log(`❌ Failed to send cold email to ${job.recruiterEmail}: ${err.message}`);
    }
  }

  log(`\n🎉 Cold Email run finished! Sent ${sentCount} outreach email(s).`);
}

/**
 * Sends a single on-demand cold outreach email from the Web Dashboard.
 */
async function sendSingleColdEmail(jobId, customOptions = {}) {
  const db = loadAppliedJobs();
  const job = db.applied.find(j => j.jobId === jobId || j.url === jobId);
  if (!job) throw new Error('Job application not found in database.');

  const recipient = customOptions.recipient || job.recruiterEmail;
  if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    throw new Error('Valid recruiter email address is required.');
  }

  const generated = await generateColdEmailContent(job);
  const subject = customOptions.subject || generated.subject;
  const body = customOptions.body || generated.body;
  const resumePath = getResumePathForJob(job);

  if (!SMTP_PASS) {
    throw new Error('SMTP_PASS is not configured in .env');
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });

  const mailOptions = {
    from: `"Aditya Mittha" <${SMTP_USER}>`,
    to: recipient,
    subject,
    text: body,
    attachments: resumePath ? [
      {
        filename: `Aditya_Mittha_Resume_${(job.category || 'Embedded')}.pdf`,
        path: resumePath,
        contentType: 'application/pdf',
      }
    ] : [],
  };

  const info = await transporter.sendMail(mailOptions);
  job.recruiterEmail = recipient;
  job.coldEmailed = true;
  job.coldEmailedAt = new Date().toISOString();
  job.coldEmailSubject = subject;
  job.coldEmailBody = body;
  job.coldEmailRecipient = recipient;
  saveAppliedJobs(db);

  return { success: true, messageId: info.messageId, recipient, subject };
}

if (require.main === module) {
  sendColdEmails();
}

module.exports = {
  sendColdEmails,
  sendSingleColdEmail,
  generateColdEmailContent,
  getResumePathForJob,
};
