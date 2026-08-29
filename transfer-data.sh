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

# --- 1. Upload Application Code & Config ---
echo ""
echo "🚀 [1/6] Uploading application code (*.js, package.json, .env, public/, docs/)..."
for f in *.js package.json .env; do
  upload_file "$f" "${REMOTE_DIR}/$f"
done
upload_dir "public" "${REMOTE_DIR}/public"
upload_dir "docs" "${REMOTE_DIR}/docs"

# --- 2. Upload Resumes & Templates ---
echo ""
echo "📄 [2/6] Uploading resumes..."
if [ -d "resume" ]; then
  for f in resume/*; do
    if [ -f "$f" ]; then
      upload_file "$f" "${REMOTE_DIR}/resume/$(basename "$f")"
    fi
  done
else
  echo "   ⚠️  resume/ directory not found."
fi

# --- 3. Upload All Portal Chrome Profiles ---
echo ""
echo "🌐 [3/6] Uploading Portal Chrome Profiles..."
PROFILES=(
  ".naukri-chrome-profile"
  ".internshala-chrome-profile"
  ".linkedin-chrome-profile"
  ".indeed-chrome-profile"
  ".wellfound-chrome-profile"
  ".foundit-chrome-profile"
)

for p in "${PROFILES[@]}"; do
  if [ -d "$p" ]; then
    echo "   Compressing $p..."
    tar czf "/tmp/${p}.tar.gz" -C . "$p" 2>/dev/null || true
    if [ -f "/tmp/${p}.tar.gz" ]; then
      scp ${SCP_OPTS} "/tmp/${p}.tar.gz" "${EC2_USER}@${EC2_IP}:/tmp/"
      $SSH_CMD "cd ${REMOTE_DIR} && tar xzf /tmp/${p}.tar.gz && rm -f /tmp/${p}.tar.gz"
      rm -f "/tmp/${p}.tar.gz"
      echo "   ✅ $p uploaded."
    fi
  else
    echo "   ℹ️  $p not found locally (will use server profile)."
  fi
done

# --- 4. Upload Applied Jobs History ---
echo ""
echo "📊 [4/6] Uploading applied-jobs.json..."
upload_file "applied-jobs.json" "${REMOTE_DIR}/applied-jobs.json"

# --- 5. Upload Server & Deployment Scripts ---
echo ""
echo "📜 [5/6] Uploading server scripts..."
for s in *.sh; do
  upload_file "$s" "${REMOTE_DIR}/$s"
done

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
