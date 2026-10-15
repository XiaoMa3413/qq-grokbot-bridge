#!/usr/bin/env bash
cd "$(dirname "$0")"
[ -z "$QQ_APP_ID" ] || [ -z "$QQ_APP_SECRET" ] && { echo "ERROR: export QQ_APP_ID and QQ_APP_SECRET first"; exit 1; }
[ -f run.pid ] && kill -0 "$(cat run.pid)" 2>/dev/null && { echo "already running (pid $(cat run.pid))"; exit 0; }
nohup setsid ./run_loop.sh >/dev/null 2>&1 & echo $! > run.pid; echo "started supervisor pid $(cat run.pid); logs in logs/"
