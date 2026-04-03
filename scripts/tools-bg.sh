#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGES_DIR="$ROOT_DIR/packages"
LOG_DIR="$ROOT_DIR/logs/tools"
PID_FILE="$ROOT_DIR/logs/tool-processes.pids"
DRY_RUN="${1:-}"

if [[ "$DRY_RUN" != "" && "$DRY_RUN" != "--dry-run" ]]; then
  echo "Usage: bash scripts/tools-bg.sh [--dry-run]" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"
: > "$PID_FILE"

# Prefer Node 22 when nvm is available, but continue if nvm is missing.
if [[ -f "$HOME/.nvm/nvm.sh" ]]; then
  set +e
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1090
  . "$HOME/.nvm/nvm.sh"
  nvm use 22 >/dev/null
  nvm_status=$?
  set -e
  if [[ $nvm_status -ne 0 ]]; then
    echo "Warning: nvm use 22 failed (exit=$nvm_status). Continuing with current Node runtime." >&2
  fi
fi

cd "$ROOT_DIR"

started=0
skipped=0

while IFS= read -r tool_dir; do
  tool_name="$(basename "$tool_dir")"

  # Only launch actual tool servers with a main entrypoint.
  if [[ ! -f "$tool_dir/src/main.ts" ]]; then
    echo "Skipping $tool_name (no src/main.ts entrypoint)"
    ((skipped += 1))
    continue
  fi

  log_file="$LOG_DIR/${tool_name}.log"

  if [[ "$DRY_RUN" == "--dry-run" ]]; then
    echo "Would start $tool_name -> $log_file"
    ((started += 1))
    continue
  fi

  GLOVE_CONFIG_DIR="$ROOT_DIR/config" \
  GLOVE_SECRETS_DIR="$ROOT_DIR/secrets" \
  pnpm --filter "./packages/${tool_name}" dev >"$log_file" 2>&1 &

  pid=$!
  echo "${tool_name}:${pid}:${log_file}" >> "$PID_FILE"
  echo "Started $tool_name (pid=$pid) -> $log_file"
  ((started += 1))
done < <(find "$PACKAGES_DIR" -mindepth 1 -maxdepth 1 -type d -name "tool-*" | sort)

echo ""
if [[ "$DRY_RUN" == "--dry-run" ]]; then
  echo "Dry run complete. Runnable tools discovered: $started, skipped: $skipped"
else
  echo "Background start complete. Tools started: $started, skipped: $skipped"
  echo "PID file: $PID_FILE"
fi
