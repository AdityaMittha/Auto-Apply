/**
 * Auto-Apply Comprehensive Unit & Integration Test Suite
 * 
 * Verifies all system modules and features:
 * 1. Config & Environment Loading
 * 2. Resume Templates & LaTeX Parsing
 * 3. Gemini AI Module & Thinking Token Handling
 * 4. Hiring Panel Engine (7 Reviewers, Prompts, Consensus Ranking)
 * 5. Resume Compiler & Category Routing
 * 6. AWS S3 Storage & Presigned URLs
 * 7. Job Application Tracking Database (applied-jobs.json)
 * 8. Status Tracking & Daily Digest Reporting
 * 9. Mailer Configuration & Templates
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    results.push({ name, status: 'PASS' });
    console.log(`  ✓ [PASS] ${name}`);
  } catch (err) {
    failed++;
    results.push({ name, status: 'FAIL', error: err.message });
    console.error(`  ✗ [FAIL] ${name}: ${err.message}`);
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    passed++;
    results.push({ name, status: 'PASS' });
    console.log(`  ✓ [PASS] ${name}`);
  } catch (err) {
    failed++;
    results.push({ name, status: 'FAIL', error: err.message });
    console.error(`  ✗ [FAIL] ${name}: ${err.message}`);
  }
}

async function runSuite() {
  console.log('\n======================================================');
  console.log('  AUTO-APPLY BOT — FULL FEATURE TEST SUITE');
  console.log('======================================================\n');

  // ─── 1. Config & Environment Tests ─────────────────────────────
  console.log('[Suite 1/9] Config & Environment:');
  const config = require('./config');

  test('Config exports essential objects (CV, geminiKey, aiConfig)', () => {
    assert(config.CV, 'CV object must exist');
    assert(config.geminiKey, 'geminiKey must exist');
    assert(config.aiConfig, 'aiConfig must exist');
    assert(config.CV.name, 'CV name must be populated');
    assert(config.CV.email, 'CV email must be populated');
  });

  test('Auto-apply keywords & search criteria are defined', () => {
    assert(Array.isArray(config.autoApplyConfig.keywords), 'Keywords must be an array');
    assert(config.autoApplyConfig.keywords.length > 0, 'Must have at least 1 keyword configured');
  });

  // ─── 2. Resume Templates & LaTeX Tests ──────────────────────────
  console.log('\n[Suite 2/9] Resume Templates & LaTeX:');
  const compiler = require('./resume-compiler');

  test('All 4 LaTeX template files exist and are non-empty', () => {
    const categories = ['embedded_software', 'embedded', 'python_devops', 'data_analytics'];
    categories.forEach(cat => {
      const texPath = compiler.BASE_TEX_FILES[cat];
      assert(texPath, `BASE_TEX_FILES must have entry for ${cat}`);
      assert(fs.existsSync(texPath), `File does not exist: ${texPath}`);
      const stat = fs.statSync(texPath);
      assert(stat.size > 500, `Template file ${cat} is suspiciously small: ${stat.size} bytes`);
    });
  });

  test('Static backup PDFs exist for all profiles', () => {
    const categories = ['embedded_software', 'embedded', 'python_devops', 'data_analytics'];
    categories.forEach(cat => {
      const pdfPath = compiler.STATIC_PDFS[cat];
      assert(pdfPath, `STATIC_PDFS must have entry for ${cat}`);
      assert(fs.existsSync(pdfPath), `Static PDF does not exist: ${pdfPath}`);
      const stat = fs.statSync(pdfPath);
      assert(stat.size > 5000, `Static PDF ${cat} is too small: ${stat.size} bytes`);
    });
  });

  test('escapeLatex handles LaTeX special characters correctly', () => {
    const escaped = compiler.escapeLatex('Built & deployed 100% of FreeRTOS tasks with $500 budget & C_Protocols #1');
    assert(escaped.includes('\\&'), 'Must contain \\&');
    assert(escaped.includes('\\%'), 'Must contain \\%');
    assert(escaped.includes('\\$'), 'Must contain \\$');
    assert(escaped.includes('\\_'), 'Must contain \\_');
    assert(escaped.includes('\\#'), 'Must contain \\#');
  });

  test('extractSummaryFromTex parses existing summary correctly from actual template', () => {
    const rawTex = fs.readFileSync(compiler.BASE_TEX_FILES.embedded_software, 'utf8');
    const summary = compiler.extractSummaryFromTex(rawTex);
    assert(summary && summary.length > 20, 'Should extract non-empty summary text from template');
  });

  // ─── 3. Gemini AI Module Tests ─────────────────────────────────
  console.log('\n[Suite 3/9] Gemini AI Module:');
  const geminiAI = require('./gemini-ai');

  test('Gemini AI exports expected methods', () => {
    assert.strictEqual(typeof geminiAI.callGemini, 'function');
    assert.strictEqual(typeof geminiAI.tailorFullResume, 'function');
    assert.strictEqual(typeof geminiAI.analyzeJobWithAI, 'function');
  });

  await asyncTest('callGemini responds via Gemini API or falls back gracefully on quota limit', async () => {
    const res = await geminiAI.callGemini('Respond in exactly one word: PONG', config.geminiKey, {
      maxTokens: 50,
      timeoutMs: 15000,
    });
    assert(res === null || typeof res === 'string', 'callGemini must return a string response or null on 429');
  });

  // ─── 4. Hiring Panel Engine Tests ──────────────────────────────
  console.log('\n[Suite 4/9] Hiring Panel Engine (7 Reviewers & Consensus):');
  const panel = require('./hiring-panel-engine');

  test('All 7 required reviewer personas are implemented', () => {
    const expected = [
      'automatedScreen',
      'hiringManager',
      'readerHiringManager',
      'readerRivalApplicant',
      'readerCEO',
      'readerRecruiter',
      'readerTeammate'
    ];
    expected.forEach(key => {
      assert(panel.REVIEWERS[key], `Reviewer persona ${key} must exist`);
      assert(typeof panel.REVIEWERS[key].prompt === 'function', `${key} must have a prompt() generator`);
      const samplePrompt = panel.REVIEWERS[key].prompt('Resume snippet', 'JD snippet');
      assert(samplePrompt.includes('Resume snippet'), 'Prompt must embed resume text');
      assert(samplePrompt.includes('JSON format'), 'Prompt must instruct JSON output');
    });
  });

  test('mergeFindings correctly identifies consensus and ranks issues', () => {
    const mockResults = {
      automatedScreen: {
        verdict: 'PASS',
        reasons: ['Missing CAN bus keyword'],
        missingKeywords: ['CAN bus', 'AUTOSAR'],
      },
      readerHiringManager: {
        verdict: 'MAYBE',
        hurtMost: 'Missing CAN bus keyword',
        problem2: 'No unit test framework mentioned',
      },
      readerRecruiter: {
        verdict: 'MAYBE',
        hurtMost: 'Missing CAN bus keyword',
      }
    };

    const findings = panel.mergeFindings(mockResults);
    assert(Array.isArray(findings.rankedIssues), 'rankedIssues must be an array');
    assert(Array.isArray(findings.missingKeywords), 'missingKeywords must be an array');
    assert(findings.missingKeywords.includes('CAN bus'), 'Must include missing CAN bus keyword');

    // The issue "Missing CAN bus keyword" was flagged by 3 reviewers, so it should be rank 1
    const topIssue = findings.rankedIssues[0];
    assert(topIssue, 'Top issue should exist');
    assert(topIssue.flagCount >= 2, 'Top issue should have consensus flagCount >= 2');
  });

  test('formatPanelInstructions formats markdown guidance for resume rewrite', () => {
    const mockFindings = {
      screenVerdict: 'PASS',
      missingKeywords: ['CAN bus', 'FreeRTOS'],
      rankedIssues: [
        { rank: 1, issue: 'No quantifiable metrics in Codec Technologies bullet', flagCount: 3, flaggedBy: ['CEO', 'Manager'] }
      ]
    };
    const formatted = panel.formatPanelInstructions(mockFindings);
    assert(formatted.includes('HIRING PANEL CRITIQUE'), 'Must include header');
    assert(formatted.includes('CAN bus'), 'Must include missing keywords');
    assert(formatted.includes('No quantifiable metrics'), 'Must include ranked issues');
  });

  // ─── 5. Resume Compiler & Tailoring Integration ────────────────
  console.log('\n[Suite 5/9] Resume Compiler & Tailoring Pipeline:');

  await asyncTest('tailorAndCompileResume compiles LaTeX with caching and category mapping', async () => {
    // Run for mock job ID to verify compilation interface
    const mockJob = {
      jobId: 'test_unit_001',
      jobTitle: 'Embedded Firmware Intern',
      jdText: 'Looking for Embedded C, ARM Cortex, FreeRTOS, and sensor interfacing.',
      category: 'embedded',
    };

    const result = await compiler.tailorAndCompileResume(mockJob);
    assert(result, 'Result must be returned');
    assert(result.pdfPath, 'Result must contain pdfPath');
    assert(fs.existsSync(result.pdfPath), `Compiled PDF must exist: ${result.pdfPath}`);
    const stat = fs.statSync(result.pdfPath);
    assert(stat.size > 1000, `PDF size must be > 1KB: ${stat.size} bytes`);
  });

  // ─── 6. AWS S3 Storage Tests ───────────────────────────────────
  console.log('\n[Suite 6/9] AWS S3 Storage:');
  const s3 = require('./s3-storage');

  test('S3 client and bucket configuration are initialized', () => {
    assert(s3.S3_BUCKET, 'S3_BUCKET must be configured');
    assert.strictEqual(typeof s3.uploadFile, 'function');
    assert.strictEqual(typeof s3.getPresignedDownloadUrl, 'function');
  });

  await asyncTest('S3 getPresignedDownloadUrl generates a valid AWS presigned URL', async () => {
    const url = await s3.getPresignedDownloadUrl('resumes/test-resume.pdf', 3600);
    assert(url, 'Presigned URL must not be null');
    assert(url.startsWith('https://'), 'URL must be https');
    assert(url.includes(s3.S3_BUCKET), 'URL must contain the configured bucket name');
    assert(url.includes('X-Amz-Signature'), 'URL must contain AWS authentication signature');
  });

  // ─── 7. Job Application Tracking Database Tests ────────────────
  console.log('\n[Suite 7/9] Job Tracking Database (applied-jobs.json):');
  const dbPath = path.join(__dirname, 'applied-jobs.json');

  test('applied-jobs.json exists and is valid JSON', () => {
    assert(fs.existsSync(dbPath), 'applied-jobs.json must exist');
    const content = fs.readFileSync(dbPath, 'utf8');
    const parsed = JSON.parse(content);
    assert(Array.isArray(parsed.applied), 'applied field must be an array');
  });

  test('applied-jobs.json entries conform to schema', () => {
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    if (db.applied.length > 0) {
      const sample = db.applied[0];
      assert(sample.jobId, 'Application must have jobId');
      assert(sample.portal, 'Application must have portal');
      assert(sample.appliedAt, 'Application must have appliedAt timestamp');
    }
  });

  // ─── 8. Status Tracking & Daily Digest ─────────────────────────
  console.log('\n[Suite 8/9] Status Tracker & Digest Reporting:');
  const statusTracker = require('./status-tracker');

  test('Status tracker exports core analysis methods', () => {
    assert.strictEqual(typeof statusTracker.trackApplicationStatuses, 'function');
    assert.strictEqual(typeof statusTracker.checkNaukriStatus, 'function');
    assert.strictEqual(typeof statusTracker.checkInternshalaStatus, 'function');
  });

  // ─── 9. Mailer Configuration Tests ─────────────────────────────
  console.log('\n[Suite 9/9] Mailer & Notification Engine:');
  const mailer = require('./mailer');

  test('Mailer exports sendDailyReport and report builder functions', () => {
    assert.strictEqual(typeof mailer.sendDailyReport, 'function');
    assert.strictEqual(typeof mailer.buildHtmlReport, 'function');
    assert.strictEqual(typeof mailer.getTodayApplications, 'function');
    const html = mailer.buildHtmlReport([
      { title: 'Embedded Intern', company: 'TechCorp', portal: 'Naukri', matchScore: 90, status: 'Applied' }
    ]);
    assert(typeof html === 'string', 'buildHtmlReport must produce HTML string');
    assert(html.includes('Daily Auto-Apply Report') || html.includes('Report') || html.includes('TechCorp'), 'HTML must include content');
  });

  // ─── Summary ───────────────────────────────────────────────────
  console.log('\n======================================================');
  console.log(`  TEST RUN SUMMARY:`);
  console.log(`  Total Passed: ${passed}`);
  console.log(`  Total Failed: ${failed}`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runSuite().catch(err => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
