#!/bin/bash
# ============================================================
#  Auto-Apply EC2 Health Check
#  Run from your LOCAL machine to check the bot's health on EC2.
#
#  Prerequisites:
#    - deploy-aws.sh must have been run (creates .deploy-info)
#    - OR pass IP and key manually: ./health-check.sh <IP> <KEY_FILE>
#
#  Usage: chmod +x health-check.sh && ./health-check.sh
# ============================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# --- Load connection info ---
if [ -f .deploy-info ]; then
  source .deploy-info
  EC2_IP="${DEPLOY_IP}"
  KEY_FILE="${DEPLOY_KEY}"
  EC2_USER="${DEPLOY_USER:-ec2-user}"
  INSTANCE_ID="${DEPLOY_INSTANCE_ID:-}"
  REGION="${DEPLOY_REGION:-ap-south-1}"
  PROFILE="${DEPLOY_PROFILE:-auto-apply}"
elif [ $# -ge 2 ]; then
  EC2_IP="$1"
  KEY_FILE="$2"
  EC2_USER="${3:-ec2-user}"
  INSTANCE_ID=""
  REGION="ap-south-1"
  PROFILE="auto-apply"
else
  echo "❌ No .deploy-info found and no arguments provided."
  echo "Usage: ./health-check.sh <EC2_IP> <KEY_FILE> [USER]"
  exit 1
fi

SCP_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10 -i ${KEY_FILE}"
SSH_CMD="ssh ${SCP_OPTS} ${EC2_USER}@${EC2_IP}"

echo "=========================================="
echo "🏥 Auto-Apply EC2 Health Check"
echo "   Target: ${EC2_USER}@${EC2_IP}"
echo "   Time:   $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "=========================================="

# --- 1. AWS Instance Status (if instance ID available) ---
if [ -n "$INSTANCE_ID" ]; then
  echo ""
  echo "☁️  [1/7] AWS Instance Status..."
  STATE=$(aws ec2 describe-instances \
    --instance-ids "$INSTANCE_ID" \
    --profile "$PROFILE" --region "$REGION" \
    --query "Reservations[0].Instances[0].State.Name" \
    --output text 2>/dev/null || echo "unknown")
  if [ "$STATE" = "running" ]; then
    echo "   ✅ Instance ${INSTANCE_ID}: ${STATE}"
  else
    echo "   ❌ Instance ${INSTANCE_ID}: ${STATE}"
    echo "   Start it with: aws ec2 start-instances --instance-ids ${INSTANCE_ID} --profile ${PROFILE} --region ${REGION}"
    exit 1
  fi
else
  echo ""
  echo "☁️  [1/7] AWS Instance Status... (skipped — no instance ID)"
fi

# --- 2. SSH Connectivity ---
echo ""
echo "🔌 [2/7] SSH Connectivity..."
if $SSH_CMD "echo ok" 2>/dev/null; then
  echo "   ✅ SSH connection successful"
else
  echo "   ❌ Cannot connect via SSH"
  echo "   Check: security group, instance state, key file"
  exit 1
fi

# --- 3. Xvfb Status ---
echo ""
echo "🖥️  [3/7] Virtual Display (Xvfb)..."
$SSH_CMD "
  if systemctl is-active auto-apply-xvfb.service &>/dev/null; then
    echo '   ✅ Xvfb systemd service: active'
  elif pgrep -x Xvfb > /dev/null; then
    echo '   ✅ Xvfb process: running'
  else
    echo '   ❌ Xvfb is NOT running!'
    echo '   Fix: sudo systemctl start auto-apply-xvfb.service'
  fi
"

# --- 4. Cron Jobs ---
echo ""
echo "⏰ [4/7] Cron Jobs..."
$SSH_CMD "
  CRON_COUNT=\$(crontab -l 2>/dev/null | grep -c 'run.sh' || echo 0)
  if [ \"\$CRON_COUNT\" -gt 0 ]; then
    echo \"   ✅ \${CRON_COUNT} cron job(s) active:\"
    crontab -l 2>/dev/null | grep 'run.sh' | while read -r line; do
      echo \"      \$line\"
    done
  else
    echo '   ❌ No cron jobs found!'
    echo '   Fix: cd ~/Auto-Apply && ./cron-setup.sh'
  fi
"

# --- 5. Last Execution ---
echo ""
echo "📋 [5/7] Last Execution (recent logs)..."
$SSH_CMD "
  cd ~/Auto-Apply 2>/dev/null || exit 0

  echo '   --- Application Log (last 15 lines) ---'
  if [ -f naukri-applications.log ]; then
    LAST_MOD=\$(stat -c '%y' naukri-applications.log 2>/dev/null | cut -d. -f1)
    echo \"   Last modified: \${LAST_MOD}\"
    echo ''
    tail -15 naukri-applications.log 2>/dev/null | sed 's/^/   /'
  else
    echo '   (no log file yet — bot may not have run yet)'
  fi

  echo ''
  echo '   --- Refresh Log (last 5 lines) ---'
  if [ -f naukri-refresh.log ]; then
    tail -5 naukri-refresh.log 2>/dev/null | sed 's/^/   /'
  else
    echo '   (no refresh log yet)'
  fi
"

# --- 6. System Resources ---
echo ""
echo "💻 [6/7] System Resources..."
$SSH_CMD "
  echo '   --- Memory ---'
  free -h | sed 's/^/   /'
  echo ''
  echo '   --- Disk ---'
  df -h / | sed 's/^/   /'
  echo ''
  echo '   --- Uptime ---'
  echo \"   \$(uptime)\"
"

# --- 7. Application Stats ---
echo ""
echo "📊 [7/7] Application Stats..."
$SSH_CMD "
  cd ~/Auto-Apply 2>/dev/null || exit 0
  if [ -f applied-jobs.json ]; then
    TOTAL=\$(node -e \"const d=require('./applied-jobs.json'); console.log(d.applied ? d.applied.length : 0)\" 2>/dev/null || echo '?')
    echo \"   Total jobs applied: \${TOTAL}\"
  else
    echo '   No applied-jobs.json found.'
  fi

  if [ -f .env ]; then
    echo '   ✅ .env file present'
  else
    echo '   ❌ .env file missing!'
  fi

  echo '   Resumes:'
  ls -la resume/ 2>/dev/null | grep -v total | sed 's/^/      /' || echo '      (none)'
"

# --- Summary ---
echo ""
echo "=========================================="
echo "🏥 Health Check Complete"
echo "=========================================="
echo "   $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo ""
