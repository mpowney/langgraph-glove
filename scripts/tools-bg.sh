#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGES_DIR="$ROOT_DIR/packages"
LOG_DIR="$ROOT_DIR/logs/tools"
PID_FILE="$ROOT_DIR/logs/tool-processes.pids"
DRY_RUN=""
TARGET_ARGS=()

usage() {
  echo "Usage: bash scripts/tools-bg.sh [--dry-run] [tool-name ...]" >&2
  echo "Examples:" >&2
  echo "  bash scripts/tools-bg.sh" >&2
  echo "  bash scripts/tools-bg.sh tool-search tool-browse" >&2
  echo "  bash scripts/tools-bg.sh search browse --dry-run" >&2
}

for arg in "$@"; do
  case "$arg" in
    --)
      ;;
    --dry-run)
      DRY_RUN="--dry-run"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      TARGET_ARGS+=("$arg")
      ;;
  esac
done

mkdir -p "$LOG_DIR"
mkdir -p "$(dirname "$PID_FILE")"
touch "$PID_FILE"

normalize_tool_name() {
  local raw="$1"
  if [[ "$raw" == tool-* ]]; then
    echo "$raw"
  else
    echo "tool-$raw"
  fi
}

tool_exists() {
  local tool_name="$1"
  [[ -d "$PACKAGES_DIR/$tool_name" && -f "$PACKAGES_DIR/$tool_name/src/main.ts" ]]
}

remove_pid_entries_for_tool() {
  local tool_name="$1"
  local tmp_file
  tmp_file="$(mktemp)"
  grep -v "^${tool_name}:" "$PID_FILE" > "$tmp_file" || true
  mv "$tmp_file" "$PID_FILE"
}

collect_target_tools() {
  if [[ ${#TARGET_ARGS[@]} -eq 0 ]]; then
    find "$PACKAGES_DIR" -mindepth 1 -maxdepth 1 -type d -name "tool-*" | sort
    return 0
  fi

  local raw
  for raw in "${TARGET_ARGS[@]}"; do
    normalize_tool_name "$raw"
  done | awk '!seen[$0]++'
}

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
already_running=0
invalid=0

while IFS= read -r tool_name; do
  [[ -z "${tool_name:-}" ]] && continue

  # Only launch actual tool servers with a main entrypoint.
  if ! tool_exists "$tool_name"; then
    echo "Skipping $tool_name (package not found or no src/main.ts entrypoint)"
    ((invalid += 1))
    continue
  fi

  existing_line="$(grep -m1 "^${tool_name}:" "$PID_FILE" || true)"
  if [[ -n "$existing_line" ]]; then
    existing_pid="$(echo "$existing_line" | cut -d: -f2)"
    if [[ "$existing_pid" =~ ^[0-9]+$ ]] && kill -0 "$existing_pid" 2>/dev/null; then
      echo "Skipping $tool_name (already running pid=$existing_pid)"
      ((already_running += 1))
      continue
    fi
    remove_pid_entries_for_tool "$tool_name"
  fi

  tool_dir="$PACKAGES_DIR/$tool_name"
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
done < <(collect_target_tools)

echo ""
if [[ "$DRY_RUN" == "--dry-run" ]]; then
  echo "Dry run complete. Tools to start: $started, already running: $already_running, invalid: $invalid, skipped: $skipped"
else
  echo "Background start complete. Tools started: $started, already running: $already_running, invalid: $invalid, skipped: $skipped"
  echo "PID file: $PID_FILE"
fi
