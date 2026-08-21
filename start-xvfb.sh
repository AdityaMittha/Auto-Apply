#!/bin/bash
# ============================================================
#  Start Xvfb virtual display (if not already running)
#  This lets headed Chrome run on a server with no monitor.
#  Sourced by run.sh before every bot execution.
# ============================================================

if ! pgrep -x Xvfb > /dev/null; then
    echo "[Xvfb] Starting virtual display :99 (1280x900x24)..."
    Xvfb :99 -screen 0 1280x900x24 -ac +extension GLX +render -noreset &
    sleep 1
    echo "[Xvfb] Virtual display started."
else
    echo "[Xvfb] Already running."
fi

export DISPLAY=:99
