/**
 * Autonomous Job Engine — UI Components & Helper Utilities
 */

const UI = {
  // Format Date into readable string
  formatDate(isoString) {
    if (!isoString) return '-';
    try {
      const d = new Date(isoString);
      return d.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoString;
    }
  },

  // Create Portal Badge
  portalBadge(portalName = 'Naukri') {
    const clean = portalName.split(' ')[0];
    return `<span class="badge badge-portal">${portalName}</span>`;
  },

  // Create Status Badge with appropriate color token
  statusBadge(status = 'APPLIED') {
    let cls = 'badge-status-applied';
    if (status.includes('VIEWED')) cls = 'badge-status-viewed';
    else if (status.includes('MANUAL')) cls = 'badge-status-manual';
    else if (status.includes('DRY')) cls = 'badge-status-dry';
    else if (status.includes('REJECTED')) cls = 'badge-status-rejected';
    else if (status.includes('SHORTLISTED')) cls = 'badge-status-applied';

    return `<span class="badge ${cls}">${status}</span>`;
  },

  // Create Match Score Badge
  scoreBadge(score = 80) {
    let cls = 'score-high';
    if (score < 60) cls = 'score-low';
    else if (score < 80) cls = 'score-med';

    return `<span class="score-badge ${cls}">${score}%</span>`;
  },

  // Show Toast Notification
  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast';
    
    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    if (type === 'error') icon = '❌';
    if (type === 'warning') icon = '⚠️';

    toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  },

  // Open Modal Helper
  openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.add('active');
  },

  // Close Modal Helper
  closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove('active');
  }
};

window.UI = UI;
