#!/bin/bash
# ============================================================
#  Unified Launcher — starts Xvfb + runs any npm script
#  Usage: ./run.sh refresh
#         ./run.sh apply
#         ./run.sh apply:all
#         ./run.sh apply:dry
#         ./run.sh mail:report
#         ./run.sh login        (first-time manual login)
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Start virtual display (only on Linux)
if [ "$(uname)" = "Linux" ]; then
    source ./start-xvfb.sh
fi

# Run the requested npm script
echo "[run.sh] Running: npm run $1"
npm run "$1" -- ${@:2}
