#!/bin/bash
# ============================================================
#  Cron Setup — replaces Windows Task Scheduler for EC2
#  Installs cron jobs for profile refresh, auto-apply, status check,
#  cold outreach, S3 sync, and email reports.
#  Usage: chmod +x cron-setup.sh && ./cron-setup.sh
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=========================================="
echo "⏰ Installing Cron Jobs"
echo "=========================================="

# Build the crontab entries
CRON_ENTRIES="
# === Auto-Apply Bot Cron Jobs (All times in IST - Asia/Kolkata) ===

# Profile refresh every hour (keeps Naukri session alive + bumps profile)
0 * * * * cd $SCRIPT_DIR && ./run.sh refresh >> $SCRIPT_DIR/naukri-refresh.log 2>&1

# Auto-apply across all 6 portals every 20 minutes between 9 AM and 10 PM IST
*/20 9-22 * * * cd $SCRIPT_DIR && ./run.sh apply:all >> $SCRIPT_DIR/naukri-applications.log 2>&1

# Check application statuses on portals at 6:00 PM IST
00 18 * * * cd $SCRIPT_DIR && ./run.sh status:check >> $SCRIPT_DIR/naukri-applications.log 2>&1

# Recruiter cold outreach at 6:30 PM IST
30 18 * * * cd $SCRIPT_DIR && ./run.sh cold:mail >> $SCRIPT_DIR/naukri-applications.log 2>&1

# S3 Backup and sync at 7:30 PM IST
30 19 * * * cd $SCRIPT_DIR && ./run.sh s3:sync >> $SCRIPT_DIR/naukri-applications.log 2>&1

# Daily email report digest at EXACTLY 8:00 PM IST
00 20 * * * cd $SCRIPT_DIR && ./run.sh mail:report >> $SCRIPT_DIR/naukri-applications.log 2>&1
"

# Merge with existing crontab (preserve other jobs)
(crontab -l 2>/dev/null | grep -v "Auto-Apply" | grep -v "run.sh" | grep -v "naukri"; echo "$CRON_ENTRIES") | crontab -

echo ""
echo "✅ Cron jobs installed! Current crontab:"
echo ""
crontab -l
echo ""
echo "=========================================="
echo "📋 Schedule Summary (IST = UTC + 5:30)"
echo "=========================================="
echo "  Every hour       → Profile refresh"
echo "  Every 10 minutes → Auto-apply all portals"
echo "  6:00 PM daily    → Check application statuses"
echo "  6:30 PM daily    → Cold outreach to recruiters"
echo "  7:30 PM daily    → S3 sync & backup"
echo "  8:00 PM daily    → Email digest report with resume attachments"
echo ""
echo "To view logs:   tail -f $SCRIPT_DIR/naukri-applications.log"
echo "To edit cron:   crontab -e"
echo "To remove cron: crontab -r"
