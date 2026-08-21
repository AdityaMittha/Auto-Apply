#!/bin/bash
# ============================================================
#  Auto-Apply EC2 Setup Script
#  Run this ONCE on a fresh Amazon Linux 2023 EC2 instance.
#  Usage: chmod +x ec2-setup.sh && ./ec2-setup.sh
# ============================================================

set -e  # Exit on any error

echo "=========================================="
echo "🚀 Auto-Apply EC2 Setup"
echo "=========================================="

# --- 1. System packages ---
echo ""
echo "📦 Installing system packages..."
sudo dnf update -y
sudo dnf install -y git

# --- 2. Chromium + Xvfb (virtual display) ---
echo ""
echo "🌐 Installing Chromium & Xvfb..."
sudo dnf install -y chromium xorg-x11-server-Xvfb

# --- 3. Node.js 20 LTS ---
echo ""
echo "📗 Installing Node.js 20 LTS..."
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs

# --- 4. Create 2GB swap (critical: 1GB RAM isn't enough for Chrome) ---
echo ""
echo "💾 Setting up 2GB swap..."
if [ ! -f /swapfile ]; then
    sudo fallocate -l 2G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile swap swap defaults 0 0' | sudo tee -a /etc/fstab
    echo "   Swap created and enabled."
else
    echo "   Swap already exists, skipping."
fi

# --- 5. Clone project (if not already done) ---
echo ""
echo "📂 Setting up project..."
if [ ! -d ~/Auto-Apply ]; then
    cd ~
    git clone https://github.com/AdityaMittha/Auto-Apply.git
    cd Auto-Apply
else
    cd ~/Auto-Apply
    git pull origin main
fi

# --- 6. Install Node dependencies ---
echo ""
echo "📦 Installing Node.js dependencies..."
npm install

# --- 7. Create .env if missing ---
if [ ! -f .env ]; then
    cp .env.example .env
    echo ""
    echo "⚠️  .env file created from template."
    echo "   Run: nano ~/Auto-Apply/.env"
    echo "   Fill in your credentials, Gemini key, etc."
fi

# --- 8. Make scripts executable ---
chmod +x run.sh start-xvfb.sh cron-setup.sh

# --- 9. Verify installation ---
echo ""
echo "=========================================="
echo "✅ Verification"
echo "=========================================="
echo "Node.js:  $(node --version)"
echo "Chromium: $(chromium-browser --version 2>/dev/null || echo 'not found — try: chromium --version')"
echo "Xvfb:     $(Xvfb -help 2>&1 | head -1 || echo 'installed')"
echo "Swap:     $(free -h | grep Swap)"
echo ""
echo "=========================================="
echo "🎉 Setup complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "  1. Edit .env:        nano ~/Auto-Apply/.env"
echo "  2. First-time login: ./run.sh login"
echo "  3. Test dry run:     DRY_RUN=true ./run.sh apply"
echo "  4. Install cron:     ./cron-setup.sh"
