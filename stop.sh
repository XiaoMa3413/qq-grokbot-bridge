#!/usr/bin/env bash
cd "$(dirname "$0")"; [ -f run.pid ] || { echo "not running"; exit 0; }
kill -- -"$(cat run.pid)" 2>/dev/null || kill "$(cat run.pid)"; rm -f run.pid; echo stopped
