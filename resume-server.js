/**
 * Lightweight Resume Web Server
 * 
 * Serves live tailored and base PDF resumes directly from the EC2 instance
 * on port 3000 so every resume link in the daily email digest opens the
 * exact, live, AI-tailored resume without external storage limitations.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.RESUME_PORT || 3000;
const RESUME_DIR = path.join(__dirname, 'resume');
const TAILORED_DIR = path.join(RESUME_DIR, 'tailored');

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let reqPath = decodeURIComponent(parsedUrl.pathname);

  // Health check
  if (reqPath === '/' || reqPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`
      <!DOCTYPE html>
      <html>
      <head><title>Resume Server - Aditya Mittha</title></head>
      <body style="font-family: sans-serif; padding: 40px; text-align: center;">
        <h2>📄 Autonomous Job Engine - Resume Server Active</h2>
        <p>Serving tailored PDF resumes for Aditya Mittha.</p>
      </body>
      </html>
    `);
  }

  // Sanitize path
  const safeFilename = path.basename(reqPath);
  let filePath = null;

  if (reqPath.startsWith('/resume/tailored/') || reqPath.startsWith('/tailored/')) {
    filePath = path.join(TAILORED_DIR, safeFilename);
  } else if (reqPath.startsWith('/resume/') || reqPath.startsWith('/resumes/')) {
    const candidatePath = path.join(RESUME_DIR, safeFilename);
    const tailoredCandidate = path.join(TAILORED_DIR, safeFilename);
    if (fs.existsSync(tailoredCandidate)) filePath = tailoredCandidate;
    else filePath = candidatePath;
  }

  if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${safeFilename}"`,
      'Cache-Control': 'public, max-age=86400',
    });
    return fs.createReadStream(filePath).pipe(res);
  }

  // Not found
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404 Not Found - Resume file does not exist.');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[ResumeServer] Serving resumes on http://0.0.0.0:${PORT}`);
});

module.exports = server;
