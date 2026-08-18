/**
 * Daily Application Mailer — Compiles all jobs and internships applied today
 * and emails an HTML summary digest to adityamittha09@gmail.com.
 */
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { CV } = require('./config');

const APPLIED_FILE = path.join(__dirname, 'applied-jobs.json');
const LOG_FILE = path.join(__dirname, 'naukri-applications.log');
const PREVIEW_FILE = path.join(__dirname, 'daily-report-preview.html');

const log = (msg) => {
  const line = `[${new Date().toLocaleString()}] [MAILER] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
};

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  const out = {};
  if (!fs.existsSync(envPath)) return out;
  for (const line of fs.readFileSync(envPath, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const E = loadEnv();
const RECIPIENT = E.REPORT_EMAIL_TO || CV.email || 'adityamittha09@gmail.com';
const SMTP_USER = E.SMTP_USER || E.GOOGLE_EMAIL || 'adityamittha09@gmail.com';
const SMTP_PASS = E.SMTP_PASS || '';

function getTodayApplications() {
  try {
    if (!fs.existsSync(APPLIED_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(APPLIED_FILE, 'utf8'));
    const todayStr = new Date().toISOString().slice(0, 10);
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

    return (data.applied || []).filter(item => {
      if (!item.appliedAt) return false;
      const itemDate = item.appliedAt.slice(0, 10);
      const itemTimestamp = new Date(item.appliedAt).getTime();
      return itemDate === todayStr || itemTimestamp >= oneDayAgo;
    });
  } catch (err) {
    log(`Error loading applied jobs: ${err.message}`);
    return [];
  }
}

function buildHtmlReport(jobs) {
  const todayFormatted = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const embeddedCount = jobs.filter(j => j.category === 'embedded').length;
  const pythonCount = jobs.filter(j => j.category === 'python_devops').length;
  const avgScore = jobs.length > 0 ? Math.round(jobs.reduce((acc, j) => acc + (j.matchScore || 0), 0) / jobs.length) : 0;

  const rows = jobs.map((job, idx) => {
    const portal = job.portal || 'Naukri';
    const statusColor = job.status === 'APPLIED' ? '#10b981' : (job.status === 'PREVIEW_DRY_RUN' ? '#f59e0b' : '#6b7280');
    const badgeColor = job.category === 'embedded' ? '#3b82f6' : '#8b5cf6';
    const time = new Date(job.appliedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

    return `
      <tr style="border-bottom: 1px solid #e5e7eb;">
        <td style="padding: 12px 14px; text-align: center; color: #6b7280; font-weight: 600;">${idx + 1}</td>
        <td style="padding: 12px 14px;">
          <div style="font-weight: 600; color: #111827;">${job.title || 'Untitled Role'}</div>
          <div style="font-size: 13px; color: #4b5563;">${job.company || 'Unknown Company'}</div>
        </td>
        <td style="padding: 12px 14px; text-align: center;">
          <span style="background: #f3f4f6; color: #374151; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 500;">
            ${portal}
          </span>
        </td>
        <td style="padding: 12px 14px; text-align: center;">
          <span style="background: ${badgeColor}15; color: ${badgeColor}; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 600;">
            ${job.matchScore || 50}% Match
          </span>
        </td>
        <td style="padding: 12px 14px; font-size: 13px; color: #4b5563;">
          📄 ${job.resumeUsed || 'Mittha_Aditya_Embedded.pdf'}
        </td>
        <td style="padding: 12px 14px; text-align: center;">
          <span style="background: ${statusColor}15; color: ${statusColor}; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 600;">
            ${job.status || 'APPLIED'}
          </span>
          <div style="font-size: 11px; color: #9ca3af; margin-top: 2px;">${time}</div>
        </td>
        <td style="padding: 12px 14px; text-align: center;">
          ${job.url ? `<a href="${job.url}" target="_blank" style="color: #2563eb; text-decoration: none; font-weight: 500; font-size: 13px;">View ↗</a>` : '-'}
        </td>
      </tr>
    `;
  }).join('');

  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <title>Daily Applications Report - Aditya Mittha</title>
  </head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f9fafb; margin: 0; padding: 24px; color: #111827;">
    <div style="max-width: 820px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e5e7eb; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
      
      <!-- Header -->
      <div style="background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%); padding: 28px 32px; color: #ffffff;">
        <h1 style="margin: 0 0 6px 0; font-size: 22px; font-weight: 700;">🎯 Daily Job & Internship Applications Report</h1>
        <p style="margin: 0; font-size: 14px; color: #bfdbfe;">Summary for ${todayFormatted} • Candidate: <strong>Aditya Mittha</strong></p>
      </div>

      <!-- Stats Banner -->
      <div style="display: flex; background: #f8fafc; padding: 20px 32px; border-bottom: 1px solid #e5e7eb; gap: 20px;">
        <div style="flex: 1; text-align: center; border-right: 1px solid #e2e8f0;">
          <div style="font-size: 28px; font-weight: 700; color: #1e3a8a;">${jobs.length}</div>
          <div style="font-size: 12px; text-transform: uppercase; color: #64748b; font-weight: 600; margin-top: 2px;">Total Processed</div>
        </div>
        <div style="flex: 1; text-align: center; border-right: 1px solid #e2e8f0;">
          <div style="font-size: 28px; font-weight: 700; color: #3b82f6;">${embeddedCount}</div>
          <div style="font-size: 12px; text-transform: uppercase; color: #64748b; font-weight: 600; margin-top: 2px;">Embedded / Firmware</div>
        </div>
        <div style="flex: 1; text-align: center; border-right: 1px solid #e2e8f0;">
          <div style="font-size: 28px; font-weight: 700; color: #8b5cf6;">${pythonCount}</div>
          <div style="font-size: 12px; text-transform: uppercase; color: #64748b; font-weight: 600; margin-top: 2px;">Python / DevOps</div>
        </div>
        <div style="flex: 1; text-align: center;">
          <div style="font-size: 28px; font-weight: 700; color: #10b981;">${avgScore}%</div>
          <div style="font-size: 12px; text-transform: uppercase; color: #64748b; font-weight: 600; margin-top: 2px;">Avg Match Score</div>
        </div>
      </div>

      <!-- Table Section -->
      <div style="padding: 24px 32px;">
        <h2 style="font-size: 16px; font-weight: 600; color: #1f2937; margin: 0 0 16px 0;">Applications Log (${jobs.length})</h2>
        
        ${jobs.length === 0 ? `
          <div style="text-align: center; padding: 40px 20px; color: #6b7280;">
            <p style="margin: 0; font-size: 15px;">No applications submitted in the last 24 hours.</p>
          </div>
        ` : `
          <div style="overflow-x: auto;">
            <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 14px;">
              <thead>
                <tr style="background: #f9fafb; color: #4b5563; font-size: 12px; text-transform: uppercase; border-bottom: 2px solid #e5e7eb;">
                  <th style="padding: 10px 14px; text-align: center;">#</th>
                  <th style="padding: 10px 14px;">Role & Company</th>
                  <th style="padding: 10px 14px; text-align: center;">Portal</th>
                  <th style="padding: 10px 14px; text-align: center;">Match</th>
                  <th style="padding: 10px 14px;">Tailored Resume</th>
                  <th style="padding: 10px 14px; text-align: center;">Status</th>
                  <th style="padding: 10px 14px; text-align: center;">Link</th>
                </tr>
              </thead>
              <tbody>
                ${rows}
              </tbody>
            </table>
          </div>
        `}
      </div>

      <!-- Footer -->
      <div style="background: #f8fafc; padding: 18px 32px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #64748b; text-align: center;">
        Generated automatically by your <strong>Antigravity Auto-Apply & Tailoring Engine</strong> for Aditya Mittha.
      </div>
    </div>
  </body>
  </html>
  `;
}

async function sendDailyReport() {
  const isPreview = process.argv.includes('preview') || process.argv.includes('--preview');
  const jobs = getTodayApplications();

  log(`Preparing daily application report (${jobs.length} applications found)...`);
  const htmlContent = buildHtmlReport(jobs);

  // Write preview HTML file
  fs.writeFileSync(PREVIEW_FILE, htmlContent, 'utf8');

  if (isPreview) {
    log(`🧪 Preview generated at: ${PREVIEW_FILE}`);
    console.log(`Open file in browser: file:///${PREVIEW_FILE.replace(/\\/g, '/')}`);
    return;
  }

  // Setup email transporter
  if (!SMTP_PASS) {
    log(`⚠️ SMTP_PASS is not set in .env. Saved HTML report to daily-report-preview.html.`);
    log(`To receive emails directly to ${RECIPIENT}, set SMTP_PASS (Gmail App Password) in .env.`);
    return;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });

  const mailOptions = {
    from: `"Antigravity Job Engine" <${SMTP_USER}>`,
    to: RECIPIENT,
    subject: `🎯 Daily Applications Summary: ${jobs.length} Jobs/Internships Applied (${new Date().toLocaleDateString()})`,
    html: htmlContent,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    log(`✅ Daily report successfully sent to ${RECIPIENT} (MessageId: ${info.messageId})`);
  } catch (err) {
    log(`❌ Failed to send email: ${err.message}`);
    log(`HTML report is preserved at: ${PREVIEW_FILE}`);
  }
}

if (require.main === module) {
  sendDailyReport();
}

module.exports = {
  sendDailyReport,
  buildHtmlReport,
  getTodayApplications,
};
