/**
 * Autonomous Job Engine — Dashboard Application Controller
 */

// Global State
const State = {
  stats: null,
  jobs: [],
  filteredJobs: [],
  selectedJob: null,
  activeView: 'view-dashboard',
};

// ─────────────────────────── INITIALIZATION ───────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  setupFilters();
  setupModals();
  setupSSELogStream();
  loadAllData();
});

// Setup Navigation Tabs
function setupNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const targetView = item.getAttribute('data-view');
      switchView(targetView);
    });
  });

  const btnViewAll = document.getElementById('btn-view-all-apps');
  if (btnViewAll) {
    btnViewAll.addEventListener('click', () => switchView('view-applications'));
  }

  const btnRefresh = document.getElementById('btn-refresh-data');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      UI.showToast('Refreshing live data...', 'info');
      loadAllData();
    });
  }
}

function switchView(viewId) {
  State.activeView = viewId;

  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-view') === viewId);
  });

  document.querySelectorAll('.view-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === viewId);
  });

  if (viewId === 'view-resumes') renderResumesVault();
  if (viewId === 'view-cold-emails') loadColdEmails();
}

// ─────────────────────────── DATA LOADING ───────────────────────────
async function loadAllData() {
  await Promise.all([loadStats(), loadJobs()]);
}

// 1. Fetch & Render Stats
async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    State.stats = data;

    document.getElementById('kpi-total-apps').innerText = data.total || 0;
    document.getElementById('kpi-today-apps').innerText = data.appliedToday || 0;
    document.getElementById('kpi-avg-score').innerText = `${data.avgScore || 80}%`;
    document.getElementById('kpi-tailored-count').innerText = data.tailoredCount || data.total || 0;
    document.getElementById('kpi-cold-count').innerText = data.coldMailedCount || 0;

    document.getElementById('sidebar-app-count').innerText = data.total || 0;
    document.getElementById('sidebar-email-count').innerText = data.coldMailedCount || 0;

    // Render Portal Distribution Bars
    renderPortalBars(data.portalCounts || {}, data.total || 1);

    // Render Status Grid
    renderStatusGrid(data.statusCounts || {});
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

function renderPortalBars(portalCounts, total) {
  const container = document.getElementById('portal-distribution-bars');
  if (!container) return;

  const portals = ['Naukri', 'LinkedIn', 'Internshala', 'Indeed', 'Wellfound', 'Foundit'];
  let html = '';

  for (const p of portals) {
    const count = portalCounts[p] || 0;
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;

    html += `
      <div class="portal-bar-row">
        <div class="portal-bar-label">${p}</div>
        <div class="portal-bar-track">
          <div class="portal-bar-fill" style="width: ${pct}%;"></div>
        </div>
        <div class="portal-bar-count">${count}</div>
      </div>
    `;
  }

  container.innerHTML = html;
}

function renderStatusGrid(statusCounts) {
  const container = document.getElementById('status-distribution-grid');
  if (!container) return;

  const keys = ['APPLIED', 'VIEWED_BY_RECRUITER', 'SHORTLISTED', 'EXTERNAL_MANUAL_REQUIRED', 'PREVIEW_DRY_RUN', 'REJECTED'];
  let html = '';

  for (const k of keys) {
    const count = statusCounts[k] || 0;
    html += `
      <div class="status-chip-card">
        <div class="status-chip-count">${count}</div>
        <div class="status-chip-label">${k.replace(/_/g, ' ')}</div>
      </div>
    `;
  }

  container.innerHTML = html;
}

// 2. Fetch & Render Jobs
async function loadJobs() {
  try {
    const res = await fetch('/api/jobs');
    const data = await res.json();
    State.jobs = data.jobs || [];
    State.filteredJobs = [...State.jobs];

    renderRecentJobs(State.jobs.slice(0, 5));
    renderAllJobsTable(State.filteredJobs);
  } catch (err) {
    console.error('Failed to load jobs:', err);
  }
}

function renderRecentJobs(jobs) {
  const tbody = document.getElementById('tbody-recent-jobs');
  if (!tbody) return;

  if (jobs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center py-4">No applications submitted yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = jobs.map(job => `
    <tr>
      <td>
        <div class="job-cell-title">${escapeHtml(job.title)}</div>
        <div class="job-cell-company">${escapeHtml(job.company)} • ${escapeHtml(job.location || 'Pune / Remote')}</div>
      </td>
      <td>${UI.portalBadge(job.portal || 'Naukri')}</td>
      <td><span class="badge" style="background: rgba(99,102,241,0.1); color:#a5b4fc;">${(job.category || 'embedded').toUpperCase()}</span></td>
      <td>${UI.scoreBadge(job.matchScore || 80)}</td>
      <td>
        <button class="btn btn-secondary btn-sm" onclick="viewResume('${encodeURIComponent(job.resumeUsed || 'Mittha_Aditya_Embedded.pdf')}')">
          📄 View PDF
        </button>
      </td>
      <td>${UI.statusBadge(job.status || 'APPLIED')}</td>
      <td>
        <button class="btn btn-ghost btn-sm" onclick="openJobDetails('${encodeURIComponent(job.jobId || job.url)}')">
          Insights ➔
        </button>
      </td>
    </tr>
  `).join('');
}

function renderAllJobsTable(jobs) {
  const tbody = document.getElementById('tbody-all-jobs');
  const paginationInfo = document.getElementById('pagination-info');
  if (!tbody) return;

  if (paginationInfo) {
    paginationInfo.innerText = `Showing ${jobs.length} of ${State.jobs.length} applications`;
  }

  if (jobs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="text-center py-4">No applications match your filter criteria.</td></tr>`;
    return;
  }

  tbody.innerHTML = jobs.map((job, idx) => `
    <tr>
      <td style="color: var(--text-muted); font-weight: 600;">${idx + 1}</td>
      <td>
        <div class="job-cell-title">${escapeHtml(job.title)}</div>
        <div class="job-cell-company">${escapeHtml(job.company)}</div>
      </td>
      <td>${UI.portalBadge(job.portal || 'Naukri')}</td>
      <td style="font-size: 12px;">${escapeHtml(job.location || 'Pune / Remote')}</td>
      <td>${UI.scoreBadge(job.matchScore || 80)}</td>
      <td>
        <button class="btn btn-secondary btn-sm" onclick="viewResume('${encodeURIComponent(job.resumeUsed || 'Mittha_Aditya_Embedded.pdf')}')">
          📄 Resume
        </button>
      </td>
      <td>${UI.statusBadge(job.status || 'APPLIED')}</td>
      <td style="font-size: 12px; color: var(--text-muted);">${UI.formatDate(job.appliedAt)}</td>
      <td>
        <div style="display: flex; gap: 6px;">
          <button class="btn btn-ghost btn-sm" title="View Full AI Insights & JD" onclick="openJobDetails('${encodeURIComponent(job.jobId || job.url)}')">
            💡 Insights
          </button>
          ${job.url ? `<a href="${job.url}" target="_blank" class="btn btn-secondary btn-sm" title="Open Job Listing">🔗</a>` : ''}
        </div>
      </td>
    </tr>
  `).join('');
}

// ─────────────────────────── RESUMES VAULT ───────────────────────────
function renderResumesVault() {
  const container = document.getElementById('resume-vault-grid');
  if (!container) return;

  const resumesMap = new Map();
  for (const j of State.jobs) {
    const key = j.resumeUsed || 'Mittha_Aditya_Embedded.pdf';
    if (!resumesMap.has(key)) {
      resumesMap.set(key, {
        filename: key,
        category: j.category || 'embedded',
        isTailored: j.isTailored || key.includes('Resume_'),
        latestRole: j.title,
        latestCompany: j.company,
        appliedAt: j.appliedAt,
        s3Url: j.s3Url,
      });
    }
  }

  const list = Array.from(resumesMap.values());
  if (list.length === 0) {
    container.innerHTML = `<div class="card glassmorphic" style="grid-column: 1/-1; text-align: center; padding: 40px;">No compiled PDF resumes yet.</div>`;
    return;
  }

  container.innerHTML = list.map(item => `
    <div class="resume-card glassmorphic">
      <div>
        <div class="resume-card-header">
          <div class="resume-card-icon">📄</div>
          <div>
            <div class="resume-card-title">${escapeHtml(item.filename)}</div>
            <div class="resume-card-sub">${item.isTailored ? '✨ AI-Tailored Per JD' : 'Master Base Template'} • ${item.category.toUpperCase()}</div>
          </div>
        </div>
        <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 8px;">
          <strong>Target Role:</strong> ${escapeHtml(item.latestRole || 'Engineering')} at ${escapeHtml(item.latestCompany || 'Target Firm')}
        </div>
      </div>
      <div class="resume-card-actions">
        <button class="btn btn-primary btn-sm" onclick="viewResume('${encodeURIComponent(item.filename)}')">
          👁️ Preview PDF
        </button>
        <a href="/api/resumes/${encodeURIComponent(item.filename)}" download class="btn btn-secondary btn-sm">
          ⬇ Download
        </a>
      </div>
    </div>
  `).join('');
}

// ─────────────────────────── COLD OUTREACH ───────────────────────────
async function loadColdEmails() {
  const tbody = document.getElementById('tbody-cold-emails');
  if (!tbody) return;

  try {
    const res = await fetch('/api/emails');
    const data = await res.json();
    const emails = data.emails || [];

    if (emails.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-center py-4">No cold emails logged yet. Run an outreach sweep or compose one.</td></tr>`;
      return;
    }

    tbody.innerHTML = emails.map(em => `
      <tr>
        <td><strong>${escapeHtml(em.recruiterEmail)}</strong></td>
        <td>
          <div>${escapeHtml(em.title)}</div>
          <div style="font-size: 11px; color: var(--text-muted);">${escapeHtml(em.company)}</div>
        </td>
        <td style="font-size: 12px;">${escapeHtml(em.subject)}</td>
        <td><span class="badge ${em.coldEmailed ? 'badge-status-applied' : 'badge-status-dry'}">${em.coldEmailed ? 'SENT' : 'PENDING'}</span></td>
        <td style="font-size: 12px; color: var(--text-muted);">${UI.formatDate(em.coldEmailedAt)}</td>
        <td>
          <button class="btn btn-secondary btn-sm" onclick="previewColdEmail('${encodeURIComponent(em.jobId)}')">
            Inspect Body
          </button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Failed to load cold emails:', err);
  }
}

// ─────────────────────────── FILTERS & SEARCH ───────────────────────────
function setupFilters() {
  const searchInput = document.getElementById('input-search-jobs');
  const portalFilter = document.getElementById('filter-portal');
  const statusFilter = document.getElementById('filter-status');
  const categoryFilter = document.getElementById('filter-category');
  const btnReset = document.getElementById('btn-reset-filters');

  function applyFilters() {
    const q = (searchInput?.value || '').toLowerCase();
    const portal = portalFilter?.value || 'all';
    const status = statusFilter?.value || 'all';
    const category = categoryFilter?.value || 'all';

    State.filteredJobs = State.jobs.filter(j => {
      const matchQ = !q || (j.title && j.title.toLowerCase().includes(q)) || (j.company && j.company.toLowerCase().includes(q)) || (j.location && j.location.toLowerCase().includes(q));
      const matchPortal = portal === 'all' || (j.portal || '').toLowerCase().includes(portal.toLowerCase());
      const matchStatus = status === 'all' || j.status === status;
      const matchCat = category === 'all' || j.category === category;
      return matchQ && matchPortal && matchStatus && matchCat;
    });

    renderAllJobsTable(State.filteredJobs);
  }

  if (searchInput) searchInput.addEventListener('input', applyFilters);
  if (portalFilter) portalFilter.addEventListener('change', applyFilters);
  if (statusFilter) statusFilter.addEventListener('change', applyFilters);
  if (categoryFilter) categoryFilter.addEventListener('change', applyFilters);

  if (btnReset) {
    btnReset.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      if (portalFilter) portalFilter.value = 'all';
      if (statusFilter) statusFilter.value = 'all';
      if (categoryFilter) categoryFilter.value = 'all';
      State.filteredJobs = [...State.jobs];
      renderAllJobsTable(State.filteredJobs);
    });
  }
}

// ─────────────────────────── MODALS & ACTIONS ───────────────────────────
function setupModals() {
  // Close buttons
  ['btn-close-job-modal', 'btn-close-pdf-modal', 'btn-close-run-modal', 'btn-cancel-run', 'btn-close-composer-modal', 'btn-cancel-composer'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.modal-backdrop').forEach(m => m.classList.remove('active'));
      });
    }
  });

  // Modal sub-tabs
  document.querySelectorAll('.modal-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-tab');
      document.querySelectorAll('.modal-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.modal-tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const content = document.getElementById(target);
      if (content) content.classList.add('active');
    });
  });

  // Run Automation Triggers
  const btnOpenRun = document.getElementById('btn-open-run-modal');
  if (btnOpenRun) {
    btnOpenRun.addEventListener('click', () => UI.openModal('modal-run-automation'));
  }

  const btnConfirmRun = document.getElementById('btn-confirm-run');
  if (btnConfirmRun) {
    btnConfirmRun.addEventListener('click', async () => {
      const task = document.getElementById('select-run-task').value;
      const dryRun = document.getElementById('checkbox-dry-run').checked;
      UI.closeModal('modal-run-automation');
      UI.showToast(`Launching ${task} (${dryRun ? 'Dry Run' : 'Live'})...`, 'info');
      switchView('view-terminal');

      try {
        const res = await fetch('/api/action/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task, dryRun }),
        });
        const data = await res.json();
        if (data.error) UI.showToast(data.error, 'error');
      } catch (err) {
        UI.showToast(`Failed to start task: ${err.message}`, 'error');
      }
    });
  }

  // Batch Cold Email Trigger
  const btnColdBatch = document.getElementById('btn-trigger-cold-batch');
  if (btnColdBatch) {
    btnColdBatch.addEventListener('click', async () => {
      UI.showToast('Starting cold outreach sweep...', 'info');
      try {
        const res = await fetch('/api/action/send-cold-mail', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const data = await res.json();
        UI.showToast(data.message || 'Cold outreach triggered.', 'success');
        setTimeout(loadColdEmails, 2000);
      } catch (err) {
        UI.showToast(`Error: ${err.message}`, 'error');
      }
    });
  }
}

// Open Job Details & AI Insights Modal
window.openJobDetails = async function(rawJobId) {
  const id = decodeURIComponent(rawJobId);
  const job = State.jobs.find(j => j.jobId === id || j.url === id);
  if (!job) return;

  State.selectedJob = job;

  document.getElementById('modal-job-title').innerText = job.title;
  document.getElementById('modal-job-company').innerText = `${job.company} • ${job.portal || 'Naukri'} • ${job.location || 'Pune / Remote'}`;
  document.getElementById('modal-score-val').innerText = `${job.matchScore || 80}%`;
  document.getElementById('modal-score-reasoning').innerText = job.aiReasoning || 'Strong foundational alignment with core engineering credentials and verified project metrics.';

  // Matched Skills Chips
  const matchedContainer = document.getElementById('modal-matched-skills');
  const matchedList = job.matchedSkills && job.matchedSkills.length > 0 ? job.matchedSkills : (job.highlightedSkills || ['Embedded C', 'FreeRTOS', 'ESP32']);
  matchedContainer.innerHTML = matchedList.map(s => `<span class="skill-chip matched">✓ ${escapeHtml(s)}</span>`).join('');

  // Missing Skills Chips
  const missingContainer = document.getElementById('modal-missing-skills');
  const missingList = job.missingSkills || [];
  missingContainer.innerHTML = missingList.length > 0
    ? missingList.map(s => `<span class="skill-chip missing">! ${escapeHtml(s)}</span>`).join('')
    : `<span style="font-size: 12px; color: var(--text-muted);">No critical skill gaps identified.</span>`;

  // Interview Tips
  const tipsContainer = document.getElementById('modal-interview-tips');
  const tipsList = job.interviewTips && job.interviewTips.length > 0 ? job.interviewTips : [
    `Be prepared to explain the architectural design of AQUANOVA/LabPulse and real-time UART/I2C communication.`,
    `Review state machine implementations in Embedded C and task synchronization in FreeRTOS.`
  ];
  tipsContainer.innerHTML = tipsList.map(t => `<li>${escapeHtml(t)}</li>`).join('');

  // Full JD
  document.getElementById('modal-full-jd-text').innerText = job.jobDescription || `${job.title} at ${job.company}\nLocation: ${job.location || 'Pune'}\n(Full Job Description text extracted from portal detail page).`;

  // Tailored Summary
  document.getElementById('modal-tailored-summary').innerText = job.tailoredSummary || `Final-year Engineering student at Walchand Institute of Technology (9.27 CGPA) with hands-on proficiency in ${matchedList.slice(0, 3).join(', ')}. Seeking the ${job.title} role at ${job.company}.`;

  // Resume & Meta tab
  document.getElementById('modal-resume-name').innerText = job.resumeUsed || 'Mittha_Aditya_Embedded.pdf';
  document.getElementById('modal-status-badge').innerHTML = UI.statusBadge(job.status || 'APPLIED');
  document.getElementById('modal-applied-at').innerText = UI.formatDate(job.appliedAt);
  
  const jobUrlLink = document.getElementById('modal-job-url');
  if (job.url) {
    jobUrlLink.href = job.url;
    jobUrlLink.style.display = 'inline';
  } else {
    jobUrlLink.style.display = 'none';
  }

  const extUrlLink = document.getElementById('modal-ext-url');
  if (job.externalUrl && job.externalUrl !== job.url) {
    extUrlLink.href = job.externalUrl;
    extUrlLink.innerText = job.externalUrl.slice(0, 45) + '... ↗';
  } else {
    extUrlLink.innerText = 'Same as listing URL';
    extUrlLink.removeAttribute('href');
  }

  const btnOpenResume = document.getElementById('btn-modal-open-resume');
  btnOpenResume.onclick = () => viewResume(encodeURIComponent(job.resumeUsed || 'Mittha_Aditya_Embedded.pdf'));

  UI.openModal('modal-job-details');
};

// Open In-Browser PDF Resume Previewer
window.viewResume = function(filename) {
  const clean = decodeURIComponent(filename);
  const pdfUrl = `/api/resumes/${encodeURIComponent(clean)}`;
  
  document.getElementById('pdf-viewer-title').innerText = `Tailored PDF Preview: ${clean}`;
  document.getElementById('pdf-preview-frame').src = pdfUrl;
  document.getElementById('btn-download-pdf').href = pdfUrl;
  document.getElementById('btn-download-pdf').setAttribute('download', clean);

  UI.openModal('modal-pdf-viewer');
};

// Preview Cold Email Body Modal
window.previewColdEmail = function(rawJobId) {
  const id = decodeURIComponent(rawJobId);
  const job = State.jobs.find(j => j.jobId === id || j.url === id);
  if (!job) return;

  document.getElementById('composer-recipient').value = job.recruiterEmail || job.coldEmailRecipient || '';
  document.getElementById('composer-subject').value = job.coldEmailSubject || `Application for ${job.title} — Aditya Mittha`;
  document.getElementById('composer-body').value = job.coldEmailBody || `Dear Hiring Team,\n\nI recently submitted my application for the ${job.title} position at ${job.company} and wanted to share my resume directly. I am a final-year E&TC student at Walchand Institute of Technology (9.27 CGPA) with hands-on experience in Embedded C, FreeRTOS, and Python.\n\nBest regards,\nAditya Mittha`;

  const btnSend = document.getElementById('btn-send-composer-email');
  btnSend.onclick = async () => {
    const recipient = document.getElementById('composer-recipient').value;
    const subject = document.getElementById('composer-subject').value;
    const body = document.getElementById('composer-body').value;

    UI.showToast('Sending cold email...', 'info');
    try {
      const res = await fetch('/api/action/send-cold-mail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.jobId || job.url, recipient, subject, body }),
      });
      const data = await res.json();
      if (data.error) UI.showToast(data.error, 'error');
      else {
        UI.showToast('Cold email sent successfully!', 'success');
        UI.closeModal('modal-cold-composer');
        loadColdEmails();
      }
    } catch (err) {
      UI.showToast(`Error: ${err.message}`, 'error');
    }
  };

  UI.openModal('modal-cold-composer');
};

// ─────────────────────────── SSE LOG STREAM ───────────────────────────
function setupSSELogStream() {
  const terminalBody = document.getElementById('terminal-log-output');
  const btnClear = document.getElementById('btn-clear-terminal');

  if (btnClear && terminalBody) {
    btnClear.addEventListener('click', () => {
      terminalBody.innerHTML = `<div class="log-line system">[SYSTEM] Console cleared.</div>`;
    });
  }

  try {
    const evtSource = new EventSource('/api/logs/stream');
    evtSource.onmessage = function(event) {
      if (!terminalBody) return;
      try {
        const data = JSON.parse(event.data);
        const lineEl = document.createElement('div');
        lineEl.className = 'log-line';
        lineEl.innerText = data.text;
        terminalBody.appendChild(lineEl);
        terminalBody.scrollTop = terminalBody.scrollHeight;
      } catch {
        const lineEl = document.createElement('div');
        lineEl.className = 'log-line';
        lineEl.innerText = event.data;
        terminalBody.appendChild(lineEl);
        terminalBody.scrollTop = terminalBody.scrollHeight;
      }
    };
  } catch (err) {
    console.warn('SSE connection error:', err);
  }
}

// Utility for HTML escaping
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
