#!/bin/bash
# ============================================================
#  Transfer Data to EC2 Instance
#  Uploads .env, resumes, Chrome profiles, and job history
#  from your local machine to the EC2 instance via SCP.
#
#  Prerequisites:
#    - deploy-aws.sh must have been run (creates .deploy-info)
#    - OR pass IP and key manually: ./transfer-data.sh <IP> <KEY_FILE>
#
#  Usage: chmod +x transfer-data.sh && ./transfer-data.sh
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# --- Load connection info ---
if [ -f .deploy-info ]; then
  source .deploy-info
  EC2_IP="${DEPLOY_IP}"
  KEY_FILE="${DEPLOY_KEY}"
  EC2_USER="${DEPLOY_USER:-ec2-user}"
elif [ $# -ge 2 ]; then
  EC2_IP="$1"
  KEY_FILE="$2"
  EC2_USER="${3:-ec2-user}"
else
  echo "❌ No .deploy-info found and no arguments provided."
  echo "Usage: ./transfer-data.sh <EC2_IP> <KEY_FILE> [USER]"
  echo "   or: Run deploy-aws.sh first to generate .deploy-info"
  exit 1
fi

REMOTE_DIR="/home/${EC2_USER}/Auto-Apply"
SCP_OPTS="-o StrictHostKeyChecking=no -i ${KEY_FILE}"
SSH_CMD="ssh ${SCP_OPTS} ${EC2_USER}@${EC2_IP}"

echo "=========================================="
echo "📦 Auto-Apply Data Transfer"
echo "   Target: ${EC2_USER}@${EC2_IP}"
echo "   Remote: ${REMOTE_DIR}"
echo "=========================================="

# --- Helper: upload file ---
upload_file() {
  local src="$1"
  local dest="$2"
  if [ -f "$src" ]; then
    echo "   📄 ${src} → ${dest}"
    scp ${SCP_OPTS} "$src" "${EC2_USER}@${EC2_IP}:${dest}"
  else
    echo "   ⚠️  ${src} not found, skipping."
  fi
}

# --- Helper: upload directory ---
upload_dir() {
  local src="$1"
  local dest="$2"
  if [ -d "$src" ]; then
    echo "   📁 ${src}/ → ${dest}/"
    scp -r ${SCP_OPTS} "$src" "${EC2_USER}@${EC2_IP}:${dest}"
  else
    echo "   ⚠️  ${src}/ not found, skipping."
  fi
}

# --- Ensure remote project directory exists ---
echo ""
echo "📂 Ensuring remote directory exists..."
$SSH_CMD "mkdir -p ${REMOTE_DIR}/resume"

# --- 1. Upload .env ---
echo ""
echo "🔐 [1/6] Uploading .env (credentials & config)..."
upload_file ".env" "${REMOTE_DIR}/.env"

# --- 2. Upload resumes ---
echo ""
echo "📄 [2/6] Uploading resumes..."
if [ -d "resume" ]; then
  for f in resume/*; do
    upload_file "$f" "${REMOTE_DIR}/resume/$(basename "$f")"
  done
else
  echo "   ⚠️  resume/ directory not found."
fi

# --- 3. Upload Naukri Chrome profile ---
echo ""
echo "🌐 [3/6] Uploading Naukri Chrome profile..."
if [ -d ".naukri-chrome-profile" ]; then
  # Compress first for faster transfer
  echo "   Compressing profile..."
  tar czf /tmp/naukri-profile.tar.gz -C . .naukri-chrome-profile
  scp ${SCP_OPTS} /tmp/naukri-profile.tar.gz "${EC2_USER}@${EC2_IP}:/tmp/"
  $SSH_CMD "cd ${REMOTE_DIR} && tar xzf /tmp/naukri-profile.tar.gz && rm /tmp/naukri-profile.tar.gz"
  rm /tmp/naukri-profile.tar.gz
  echo "   ✅ Naukri Chrome profile uploaded."
else
  echo "   ⚠️  .naukri-chrome-profile/ not found, skipping."
  echo "   You'll need to do a manual login on EC2 (./run.sh login via VNC)."
fi

# --- 4. Upload Internshala Chrome profile ---
echo ""
echo "🌐 [4/6] Uploading Internshala Chrome profile..."
if [ -d ".internshala-chrome-profile" ]; then
  echo "   Compressing profile..."
  tar czf /tmp/internshala-profile.tar.gz -C . .internshala-chrome-profile
  scp ${SCP_OPTS} /tmp/internshala-profile.tar.gz "${EC2_USER}@${EC2_IP}:/tmp/"
  $SSH_CMD "cd ${REMOTE_DIR} && tar xzf /tmp/internshala-profile.tar.gz && rm /tmp/internshala-profile.tar.gz"
  rm /tmp/internshala-profile.tar.gz
  echo "   ✅ Internshala Chrome profile uploaded."
else
  echo "   ⚠️  .internshala-chrome-profile/ not found, skipping."
fi

# --- 5. Upload applied jobs history ---
echo ""
echo "📊 [5/6] Uploading applied-jobs.json (application history)..."
upload_file "applied-jobs.json" "${REMOTE_DIR}/applied-jobs.json"

# --- 6. Upload setup & deployment scripts ---
echo ""
echo "📜 [6/6] Uploading server scripts..."
upload_file "server-setup.sh" "${REMOTE_DIR}/server-setup.sh"
upload_file "health-check.sh" "${REMOTE_DIR}/health-check.sh"
upload_file "cron-setup.sh" "${REMOTE_DIR}/cron-setup.sh"
upload_file "run.sh" "${REMOTE_DIR}/run.sh"
upload_file "start-xvfb.sh" "${REMOTE_DIR}/start-xvfb.sh"

# Make scripts executable on remote
$SSH_CMD "chmod +x ${REMOTE_DIR}/*.sh 2>/dev/null || true"

# --- Verify ---
echo ""
echo "=========================================="
echo "✅ Transfer Complete!"
echo "=========================================="
echo ""
echo "Uploaded files on EC2:"
$SSH_CMD "cd ${REMOTE_DIR} && echo '' && echo '  Config:' && ls -la .env 2>/dev/null && echo '  Resumes:' && ls resume/ 2>/dev/null && echo '  Chrome Profiles:' && ls -d .naukri-chrome-profile .internshala-chrome-profile 2>/dev/null && echo '  History:' && ls -la applied-jobs.json 2>/dev/null" || true
echo ""
echo "Next steps:"
echo "  1. SSH in:      ssh -i ${KEY_FILE} ${EC2_USER}@${EC2_IP}"
echo "  2. Setup:       cd ~/Auto-Apply && ./server-setup.sh"
echo "  3. Test login:  cd ~/Auto-Apply && ./run.sh login"
echo "  4. Activate:    cd ~/Auto-Apply && ./cron-setup.sh"
