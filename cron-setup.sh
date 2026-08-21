#!/bin/bash
# ============================================================
#  Cron Setup — replaces Windows Task Scheduler for EC2
#  Installs cron jobs for profile refresh, auto-apply, and email reports.
#  Usage: chmod +x cron-setup.sh && ./cron-setup.sh
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=========================================="
echo "⏰ Installing Cron Jobs"
echo "=========================================="

# Build the crontab entries
CRON_ENTRIES="
# === Auto-Apply Bot Cron Jobs ===

# Profile refresh every hour (keeps Naukri session alive + bumps profile)
0 * * * * cd $SCRIPT_DIR && ./run.sh refresh >> $SCRIPT_DIR/naukri-refresh.log 2>&1

# Auto-apply across all 6 portals every 10 minutes
*/10 * * * * cd $SCRIPT_DIR && ./run.sh apply:all >> $SCRIPT_DIR/naukri-applications.log 2>&1

# Daily email report at 8 PM IST (2:30 PM UTC)
30 14 * * * cd $SCRIPT_DIR && ./run.sh mail:report >> $SCRIPT_DIR/naukri-applications.log 2>&1
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
echo "  8:00 PM daily    → Email digest report"
echo ""
echo "To view logs:   tail -f $SCRIPT_DIR/naukri-applications.log"
echo "To edit cron:   crontab -e"
echo "To remove cron: crontab -r"
