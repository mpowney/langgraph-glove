#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/logs/tool-processes.pids"

if [[ ! -f "$PID_FILE" ]]; then
  echo "No PID file found at $PID_FILE"
  exit 0
fi

terminated=0
already_stopped=0
skipped=0

while IFS=: read -r tool_name pid log_file; do
  if [[ -z "${tool_name:-}" || -z "${pid:-}" ]]; then
    continue
  fi

  if ! [[ "$pid" =~ ^[0-9]+$ ]]; then
    echo "Skipping $tool_name (invalid pid: $pid)"
    ((skipped += 1))
    continue
  fi

  if ! kill -0 "$pid" 2>/dev/null; then
    echo "$tool_name already stopped (pid=$pid)"
    ((already_stopped += 1))
    continue
  fi

  command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"

  # Safety check: only terminate processes that look like tool package dev runs.
  if [[ "$command_line" != *"packages/${tool_name}"* && "$command_line" != *"pnpm --filter ./packages/${tool_name}"* && "$command_line" != *"pnpm --filter \"./packages/${tool_name}\""* ]]; then
    echo "Skipping $tool_name (pid=$pid) due to command mismatch"
    ((skipped += 1))
    continue
  fi

  kill "$pid" 2>/dev/null || true

  # Wait briefly for graceful shutdown.
  for _ in {1..20}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done

  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
  fi

  echo "Stopped $tool_name (pid=$pid)"
  ((terminated += 1))
done < "$PID_FILE"

rm -f "$PID_FILE"

echo ""
echo "Tool stop complete. Terminated: $terminated, already stopped: $already_stopped, skipped: $skipped"
