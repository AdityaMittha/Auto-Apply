#!/bin/bash
# ============================================================
#  Auto-Apply Server Setup Script
#  Run this on the EC2 instance after SSH-ing in.
#  Installs all dependencies, configures VNC, systemd, and timezone.
#
#  Usage: chmod +x server-setup.sh && ./server-setup.sh
# ============================================================

set -e

echo "=========================================="
echo "🚀 Auto-Apply Server Setup (Enhanced)"
echo "=========================================="

# --- 1. System packages ---
echo ""
echo "📦 [1/10] Updating system packages..."
sudo dnf update -y

# --- 2. Google Chrome + Xvfb (AL2023 compatible) ---
echo ""
echo "🌐 [2/10] Installing Google Chrome & Xvfb..."

# Google Chrome — add repo if not present
if ! command -v google-chrome-stable &>/dev/null; then
  sudo tee /etc/yum.repos.d/google-chrome.repo > /dev/null <<'CHROMEREPO'
[google-chrome]
name=Google Chrome
baseurl=https://dl.google.com/linux/chrome/rpm/stable/x86_64
enabled=1
gpgcheck=1
gpgkey=https://dl.google.com/linux/linux_signing_key.pub
CHROMEREPO
  sudo dnf install -y google-chrome-stable
  echo "   ✅ Google Chrome installed."
else
  echo "   Google Chrome already installed."
fi

# Xvfb — try multiple package names (varies by AL2023 version)
if ! command -v Xvfb &>/dev/null; then
  sudo dnf install -y xorg-x11-server-Xvfb 2>/dev/null \
    || sudo dnf install -y Xvfb 2>/dev/null \
    || sudo dnf install -y xvfb-run 2>/dev/null \
    || {
      # Fallback: install from EPEL
      sudo dnf install -y https://dl.fedoraproject.org/pub/epel/epel-release-latest-9.noarch.rpm 2>/dev/null || true
      sudo dnf install -y xorg-x11-server-Xvfb
    }
  echo "   ✅ Xvfb installed."
else
  echo "   Xvfb already installed."
fi

# Install additional deps Chrome needs
sudo dnf install -y \
  nss atk at-spi2-atk cups-libs libdrm libXcomposite \
  libXdamage libXrandr mesa-libgbm pango alsa-lib \
  libxkbcommon 2>/dev/null || true

# --- 3. Node.js 20 LTS ---
echo ""
echo "📗 [3/10] Installing Node.js 20 LTS..."
if command -v node &>/dev/null; then
  echo "   Node.js already installed: $(node --version)"
else
  curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
  sudo dnf install -y nodejs
fi

# --- 4. Git ---
echo ""
echo "📂 [4/10] Installing Git..."
sudo dnf install -y git

# --- 5. 2GB Swap ---
echo ""
echo "💾 [5/10] Setting up 2GB swap (critical for Chrome on 1GB RAM)..."
if [ ! -f /swapfile ]; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile swap swap defaults 0 0' | sudo tee -a /etc/fstab
  echo "   ✅ Swap created and enabled."
else
  echo "   Swap already exists."
fi

# --- 6. Set timezone to IST ---
echo ""
echo "🕐 [6/10] Setting timezone to IST (Asia/Kolkata)..."
sudo timedatectl set-timezone Asia/Kolkata
echo "   ✅ Timezone: $(timedatectl | grep 'Time zone')"

# --- 7. TigerVNC Server (for visual debugging) ---
echo ""
echo "🖥️  [7/10] Installing TigerVNC Server..."
sudo dnf install -y tigervnc-server

# Create VNC startup script
mkdir -p ~/.vnc
cat > ~/.vnc/xstartup <<'VNCEOF'
#!/bin/bash
# Minimal VNC desktop — just enough to see Chrome
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
export DISPLAY=:1
# Use a simple window manager if available, otherwise just run xterm
if command -v fluxbox &>/dev/null; then
  fluxbox &
elif command -v xterm &>/dev/null; then
  xterm &
fi
VNCEOF
chmod +x ~/.vnc/xstartup

echo "   ✅ VNC installed. Set password with: vncpasswd"
echo "   Start with: vncserver :1 -geometry 1280x900 -depth 24"

# --- 8. Clone project (if not already done) ---
echo ""
echo "📂 [8/10] Setting up project..."
if [ ! -d ~/Auto-Apply ]; then
  cd ~
  git clone https://github.com/AdityaMittha/Auto-Apply.git
  cd ~/Auto-Apply
else
  cd ~/Auto-Apply
  git pull origin main || true
fi

# --- 9. Install Node dependencies ---
echo ""
echo "📦 [9/10] Installing Node.js dependencies..."
cd ~/Auto-Apply
npm install

# Install Playwright Chromium browser
echo "   Installing Playwright Chromium..."
npx playwright install chromium || true

# --- 10. Create systemd service for auto-restart ---
echo ""
echo "⚙️  [10/10] Setting up systemd service & log rotation..."

# Systemd service for the main auto-apply cron runner
sudo tee /etc/systemd/system/auto-apply-xvfb.service > /dev/null <<'SVCEOF'
[Unit]
Description=Xvfb Virtual Display for Auto-Apply Bot
After=network.target

[Service]
Type=simple
User=ec2-user
ExecStart=/usr/bin/Xvfb :99 -screen 0 1280x900x24 -ac +extension GLX +render -noreset
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF

sudo systemctl daemon-reload
sudo systemctl enable auto-apply-xvfb.service
sudo systemctl start auto-apply-xvfb.service
echo "   ✅ Xvfb systemd service created and started."

# Log rotation
sudo tee /etc/logrotate.d/auto-apply > /dev/null <<'LOGEOF'
/home/ec2-user/Auto-Apply/*.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
    create 0644 ec2-user ec2-user
}
LOGEOF
echo "   ✅ Log rotation configured (7 days, compressed)."

# --- Create .env if missing ---
if [ ! -f ~/Auto-Apply/.env ]; then
  if [ -f ~/Auto-Apply/.env.example ]; then
    cp ~/Auto-Apply/.env.example ~/Auto-Apply/.env
    echo ""
    echo "   ⚠️  .env created from template — fill it in or use transfer-data.sh"
  fi
fi

# Make scripts executable
chmod +x ~/Auto-Apply/*.sh 2>/dev/null || true

# --- Verification ---
echo ""
echo "=========================================="
echo "✅ Verification"
echo "=========================================="
echo "  Node.js:    $(node --version)"
echo "  npm:        $(npm --version)"
echo "  Chrome:     $(google-chrome-stable --version 2>/dev/null || echo 'not found')"
echo "  Xvfb:       $(systemctl is-active auto-apply-xvfb.service)"
echo "  Timezone:   $(date +%Z) ($(date))"
echo "  Swap:       $(free -h | grep Swap)"
echo "  Disk:       $(df -h / | tail -1)"
echo ""
echo "=========================================="
echo "🎉 Server setup complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "  1. Run transfer-data.sh from your LOCAL machine to upload .env, resumes, Chrome profiles"
echo "  2. Set VNC password:    vncpasswd"
echo "  3. Start VNC:           vncserver :1 -geometry 1280x900 -depth 24"
echo "  4. First-time login:    cd ~/Auto-Apply && ./run.sh login"
echo "  5. Install cron:        cd ~/Auto-Apply && ./cron-setup.sh"
