#!/usr/bin/env bash
# Supervisor: restarts bridge.js on crash with backoff. Exit 78 = missing config -> stop.
cd "$(dirname "$0")"; d=2
while true; do
  s=$(date +%s); node bridge.js >> logs/bridge.log 2>&1; rc=$?
  echo "$(date -Is) bridge exited rc=$rc" >> logs/supervisor.log
  [ $rc -eq 78 ] && { echo "missing env, supervisor stopping" >> logs/supervisor.log; exit 78; }
  [ $(( $(date +%s) - s )) -gt 60 ] && d=2
  sleep $d; d=$(( d*2 > 60 ? 60 : d*2 ))
done
