#!/usr/bin/env bash
# Supervisor: restarts bridge.js on crash with backoff, plus a background health monitor that
# kills a hung bridge. Exit 78 = missing config -> stop.
cd "$(dirname "$0")"; d=2
node bridge.js >> logs/bridge.log 2>&1 & pid=$!
# Background monitor: every 30s check /health; kill the bridge once it hangs or stops responding.
( fails=0
  while true; do
    sleep 30
    if curl -fsS -m 5 "http://127.0.0.1:${QQ_REPLY_PORT:-8787}/health" >/dev/null; then
      fails=0
    else
      fails=$((fails + 1))
      logAge=$(( $(date +%s) - $(stat -c %Y logs/bridge.log 2>/dev/null || echo 0) ))
      if [ "$fails" -ge 3 ] || [ "$logAge" -gt 600 ]; then
        echo "$(date -Is) health monitor killing $pid" >> logs/supervisor.log
        kill -9 "$pid"
        exit
      fi
    fi
  done
) & mon=$!
while true; do
  s=$(date +%s); wait $pid; rc=$?
  echo "$(date -Is) bridge exited rc=$rc" >> logs/supervisor.log
  kill "$mon" 2>/dev/null
  [ $rc -eq 78 ] && { echo "missing env, supervisor stopping" >> logs/supervisor.log; exit 78; }
  [ $(( $(date +%s) - s )) -gt 60 ] && d=2
  sleep $d; d=$(( d*2 > 60 ? 60 : d*2 ))
  node bridge.js >> logs/bridge.log 2>&1 & pid=$!
done
