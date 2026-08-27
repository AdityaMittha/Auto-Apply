/**
 * Autonomous Job Engine — Web Dashboard Server
 * 
 * Provides REST APIs, SSE real-time log streaming, tailored PDF streaming,
 * and hosts the rich single-page application dashboard.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { sendSingleColdEmail, sendColdEmails } = require('./cold-mailer');

const PORT = parseInt(process.env.DASHBOARD_PORT || process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const RESUME_DIR = path.join(__dirname, 'resume');
const TAILORED_DIR = path.join(RESUME_DIR, 'tailored');
const APPLIED_FILE = path.join(__dirname, 'applied-jobs.json');
const LOG_FILE = path.join(__dirname, 'naukri-applications.log');

// Ensure public directories exist
['public', 'public/css', 'public/js'].forEach(dir => {
  const full = path.join(__dirname, dir);
  if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
});

function loadAppliedData() {
  try {
    if (fs.existsSync(APPLIED_FILE)) {
      return JSON.parse(fs.readFileSync(APPLIED_FILE, 'utf8'));
    }
  } catch {}
  return { applied: [], lastUpdated: null };
}

function saveAppliedData(data) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(APPLIED_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Active background execution process tracker
let activeProcess = null;
const sseClients = new Set();

function broadcastLog(line) {
  const dataStr = `data: ${JSON.stringify({ text: line, timestamp: new Date().toISOString() })}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(dataStr);
    } catch {}
  }
}

// MIME types for static assets
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(parsedUrl.pathname);
  const method = req.method.toUpperCase();

  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // ─────────────────────────── API ROUTES ───────────────────────────

  // 1. GET /api/stats - Aggregated Metrics & KPIs
  if (pathname === '/api/stats' && method === 'GET') {
    const db = loadAppliedData();
    const list = db.applied || [];
    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    const total = list.length;
    const appliedToday = list.filter(j => j.appliedAt && new Date(j.appliedAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) === todayIST).length;
    
    // Status breakdown
    const statusCounts = {};
    // Portal breakdown
    const portalCounts = {};
    // Category breakdown
    const categoryCounts = { embedded_software: 0, embedded: 0, python_devops: 0, data_analytics: 0, general: 0 };
    let scoreSum = 0;
    let scoreCount = 0;
    let coldMailedCount = 0;
    let tailoredCount = 0;

    for (const item of list) {
      const st = item.status || 'APPLIED';
      statusCounts[st] = (statusCounts[st] || 0) + 1;

      const portalClean = (item.portal || 'Naukri').split(' ')[0];
      portalCounts[portalClean] = (portalCounts[portalClean] || 0) + 1;

      const cat = item.category === 'embedded_software' ? 'embedded_software' : (item.category === 'data_analytics' ? 'data_analytics' : (item.category === 'python_devops' ? 'python_devops' : (item.category === 'embedded' ? 'embedded' : 'general')));
      categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;

      if (typeof item.matchScore === 'number') {
        scoreSum += item.matchScore;
        scoreCount++;
      }
      if (item.coldEmailed || item.coldEmailedAt) coldMailedCount++;
      if (item.isTailored || (item.resumeUsed && item.resumeUsed.includes('Resume_'))) tailoredCount++;
    }

    const avgScore = scoreCount > 0 ? Math.round(scoreSum / scoreCount) : 80;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      total,
      appliedToday,
      avgScore,
      coldMailedCount,
      tailoredCount,
      statusCounts,
      portalCounts,
      categoryCounts,
      lastUpdated: db.lastUpdated,
      isEngineRunning: Boolean(activeProcess),
    }));
  }

  // 2. GET /api/jobs - Query & Filter Applications
  if (pathname === '/api/jobs' && method === 'GET') {
    const db = loadAppliedData();
    let list = [...(db.applied || [])];

    const q = (parsedUrl.searchParams.get('q') || '').toLowerCase();
    const portal = parsedUrl.searchParams.get('portal');
    const status = parsedUrl.searchParams.get('status');
    const category = parsedUrl.searchParams.get('category');
    const minScore = parseInt(parsedUrl.searchParams.get('minScore') || '0', 10);

    if (q) {
      list = list.filter(j => 
        (j.title && j.title.toLowerCase().includes(q)) ||
        (j.company && j.company.toLowerCase().includes(q)) ||
        (j.location && j.location.toLowerCase().includes(q))
      );
    }
    if (portal && portal !== 'all') {
      list = list.filter(j => (j.portal || '').toLowerCase().includes(portal.toLowerCase()));
    }
    if (status && status !== 'all') {
      list = list.filter(j => j.status === status);
    }
    if (category && category !== 'all') {
      list = list.filter(j => j.category === category);
    }
    if (minScore > 0) {
      list = list.filter(j => (j.matchScore || 0) >= minScore);
    }

    // Sort newest first
    list.sort((a, b) => new Date(b.appliedAt || 0) - new Date(a.appliedAt || 0));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ jobs: list, total: list.length }));
  }

  // 3. GET /api/jobs/:id - Single Job Details
  if (pathname.startsWith('/api/jobs/') && method === 'GET' && !pathname.endsWith('/status')) {
    const rawId = pathname.replace('/api/jobs/', '');
    const id = decodeURIComponent(rawId);
    const db = loadAppliedData();
    const job = (db.applied || []).find(j => j.jobId === id || j.url === id);

    if (!job) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Job application not found' }));
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(job));
  }

  // 4. PUT /api/jobs/:id/status - Update Job Status
  if (pathname.startsWith('/api/jobs/') && pathname.endsWith('/status') && method === 'PUT') {
    const rawId = pathname.replace('/api/jobs/', '').replace('/status', '');
    const id = decodeURIComponent(rawId);

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const db = loadAppliedData();
        const job = (db.applied || []).find(j => j.jobId === id || j.url === id);

        if (!job) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Job not found' }));
        }

        if (payload.status) job.status = payload.status;
        if (payload.notes) job.userNotes = payload.notes;
        saveAppliedData(db);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, job }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 5. GET /api/emails - List Cold Outreach Logs
  if (pathname === '/api/emails' && method === 'GET') {
    const db = loadAppliedData();
    const emails = (db.applied || [])
      .filter(j => j.coldEmailed || j.coldEmailedAt || j.recruiterEmail)
      .map(j => ({
        jobId: j.jobId || j.url,
        title: j.title,
        company: j.company,
        recruiterEmail: j.recruiterEmail || j.coldEmailRecipient,
        coldEmailed: Boolean(j.coldEmailed),
        coldEmailedAt: j.coldEmailedAt,
        subject: j.coldEmailSubject || `Application for ${j.title} — Aditya Mittha`,
        body: j.coldEmailBody || '',
        resumeUsed: j.resumeUsed,
      }))
      .sort((a, b) => new Date(b.coldEmailedAt || 0) - new Date(a.coldEmailedAt || 0));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ emails, count: emails.length }));
  }

  // 6. POST /api/action/send-cold-mail - Send On-Demand Cold Email
  if (pathname === '/api/action/send-cold-mail' && method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        if (payload.jobId) {
          const result = await sendSingleColdEmail(payload.jobId, {
            recipient: payload.recipient,
            subject: payload.subject,
            body: payload.body,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(result));
        } else {
          // Batch run
          sendColdEmails().catch(() => {});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, message: 'Batch cold email run triggered.' }));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 7. POST /api/action/run - Trigger Automation Scripts
  if (pathname === '/api/action/run' && method === 'POST') {
    if (activeProcess) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Another automation task is currently running.' }));
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      const task = payload.task || 'apply-all'; // 'apply-all', 'naukri', 'linkedin', 'indeed', 'internshala', 'wellfound', 'foundit', 'status-check'
      const dryRun = Boolean(payload.dryRun);

      let script = 'apply-all.js';
      if (task === 'naukri') script = 'naukri-auto-apply.js';
      else if (task === 'linkedin') script = 'linkedin-apply.js';
      else if (task === 'indeed') script = 'indeed-apply.js';
      else if (task === 'internshala') script = 'internshala-apply.js';
      else if (task === 'wellfound') script = 'wellfound-apply.js';
      else if (task === 'foundit') script = 'foundit-apply.js';
      else if (task === 'status-check') script = 'status-tracker.js';

      const args = [path.join(__dirname, script)];
      if (dryRun) args.push('dry');

      broadcastLog(`🚀 [ENGINE] Starting automation task: ${task} (Dry Run: ${dryRun ? 'YES' : 'NO'})`);

      activeProcess = spawn('node', args, { cwd: __dirname });

      activeProcess.stdout.on('data', data => {
        const text = data.toString();
        process.stdout.write(text);
        text.split('\n').forEach(line => {
          if (line.trim()) broadcastLog(line.trim());
        });
      });

      activeProcess.stderr.on('data', data => {
        const text = data.toString();
        process.stderr.write(text);
        text.split('\n').forEach(line => {
          if (line.trim()) broadcastLog(`⚠️ ${line.trim()}`);
        });
      });

      activeProcess.on('close', code => {
        broadcastLog(`✅ [ENGINE] Automation task ${task} finished with exit code ${code}`);
        activeProcess = null;
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, message: `Started ${task}`, dryRun }));
    });
    return;
  }

  // 8. GET /api/logs/stream - Server-Sent Events (SSE) for Real-Time Logs
  if (pathname === '/api/logs/stream' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ text: 'Connected to live automation log stream.', timestamp: new Date().toISOString() })}\n\n`);
    sseClients.add(res);

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // 9. GET /api/logs/recent - Fetch Recent Log Lines
  if (pathname === '/api/logs/recent' && method === 'GET') {
    let recentLines = [];
    if (fs.existsSync(LOG_FILE)) {
      const raw = fs.readFileSync(LOG_FILE, 'utf8');
      const lines = raw.split(/\r?\n/).filter(Boolean);
      recentLines = lines.slice(-60);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ lines: recentLines }));
  }

  // 10. PDF Resume Streaming (/resume/*, /api/resumes/*)
  if (pathname.startsWith('/resume/') || pathname.startsWith('/resumes/') || pathname.startsWith('/api/resumes/')) {
    const filename = path.basename(pathname);
    let filePath = path.join(TAILORED_DIR, filename);
    if (!fs.existsSync(filePath)) filePath = path.join(RESUME_DIR, filename);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'public, max-age=86400',
      });
      return fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found - Resume PDF does not exist.');
    }
  }

  // ─────────────────────────── STATIC FILES ───────────────────────────

  let staticFilePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!fs.existsSync(staticFilePath) || fs.statSync(staticFilePath).isDirectory()) {
    staticFilePath = path.join(PUBLIC_DIR, 'index.html');
  }

  if (fs.existsSync(staticFilePath) && fs.statSync(staticFilePath).isFile()) {
    const ext = path.extname(staticFilePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': contentType });
    return fs.createReadStream(staticFilePath).pipe(res);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404 Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n=======================================================`);
  console.log(`🌐 Autonomous Job Engine — Web Dashboard Active`);
  console.log(`🚀 URL: http://localhost:${PORT}`);
  console.log(`📊 API Endpoints: /api/stats, /api/jobs, /api/emails`);
  console.log(`=======================================================\n`);
});

module.exports = server;
