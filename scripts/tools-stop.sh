#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/logs/tool-processes.pids"
TARGET_ARGS=()

usage() {
  echo "Usage: bash scripts/tools-stop.sh [tool-name ...]" >&2
  echo "Examples:" >&2
  echo "  bash scripts/tools-stop.sh" >&2
  echo "  bash scripts/tools-stop.sh tool-search tool-browse" >&2
  echo "  bash scripts/tools-stop.sh search browse" >&2
}

normalize_tool_name() {
  local raw="$1"
  if [[ "$raw" == tool-* ]]; then
    echo "$raw"
  else
    echo "tool-$raw"
  fi
}

for arg in "$@"; do
  case "$arg" in
    --)
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

targeted_tool() {
  local tool_name="$1"
  local raw

  if [[ ${#TARGET_ARGS[@]} -eq 0 ]]; then
    return 0
  fi

  for raw in "${TARGET_ARGS[@]}"; do
    if [[ "$(normalize_tool_name "$raw")" == "$tool_name" ]]; then
      return 0
    fi
  done

  return 1
}

get_pid_cwd() {
  local pid="$1"

  # macOS/BSD-compatible way to query cwd for a pid.
  lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | awk '/^n/ { sub(/^n/, "", $0); print; exit }'
}

list_child_pids() {
  local parent_pid="$1"
  local children

  children="$(ps -axo pid=,ppid= | awk -v ppid="$parent_pid" '$2 == ppid { print $1 }')"
  if [[ -z "${children:-}" ]]; then
    return 0
  fi

  while IFS= read -r child_pid; do
    [[ -z "${child_pid:-}" ]] && continue
    echo "$child_pid"
    list_child_pids "$child_pid"
  done <<< "$children"
}

collect_tool_pids() {
  local tool_name="$1"
  local seed_pid="$2"
  local cmd
  local all_pids=""

  if [[ -n "${seed_pid:-}" ]] && kill -0 "$seed_pid" 2>/dev/null; then
    all_pids+="$seed_pid"$'\n'
    all_pids+="$(list_child_pids "$seed_pid")"$'\n'
  fi

  # Fallback for stale/missing seed pid: match process command lines for this tool.
  while IFS= read -r pid; do
    [[ -z "${pid:-}" ]] && continue
    all_pids+="$pid"$'\n'
  done < <(ps -axww -o pid=,command= | awk -v tool="$tool_name" -v root="$ROOT_DIR" '
    (index($0, "pnpm --filter ./packages/" tool " dev") ||
     index($0, "pnpm --filter \"./packages/" tool "\" dev") ||
     index($0, root "/packages/" tool "/src/main.ts") ||
     index($0, root "/packages/" tool "/node_modules/.bin/../tsx/dist/cli.mjs") ||
     index($0, root "/node_modules/.pnpm/tsx@")) &&
    $2 ~ /node|pnpm/
    { print $1 }
  ')

  if [[ -n "$all_pids" ]]; then
    echo "$all_pids" | awk 'NF' | sort -u
  fi
}

safe_command_match() {
  local tool_name="$1"
  local pid="$2"
  local command_line
  local cwd

  command_line="$(ps -p "$pid" -ww -o command= 2>/dev/null || true)"
  cwd="$(get_pid_cwd "$pid")"

  [[ "$command_line" == *"pnpm --filter ./packages/${tool_name} dev"* ||
     "$command_line" == *"pnpm --filter \"./packages/${tool_name}\" dev"* ||
      "$command_line" == *"$ROOT_DIR/packages/${tool_name}/src/main.ts"* ||
      "$command_line" == *"$ROOT_DIR/packages/${tool_name}/node_modules/.bin/../tsx/dist/cli.mjs"* ||
    ("$command_line" == *"$ROOT_DIR/node_modules/.pnpm/tsx@"* && ("$cwd" == "$ROOT_DIR/packages/${tool_name}" || "$cwd" == "$ROOT_DIR/packages/${tool_name}/"*)) ]]
}

if [[ ! -f "$PID_FILE" ]]; then
  echo "No PID file found at $PID_FILE"
  exit 0
fi

terminated=0
already_stopped=0
skipped=0
kept=0
tmp_pid_file="$(mktemp)"
results_dir="$(mktemp -d)"
job_index=0
job_pids=()

log_tool_progress() {
  local tool_name="$1"
  local message="$2"
  echo "[$tool_name] $message"
}

process_tool_entry() {
  local tool_name="$1"
  local pid="$2"
  local log_file="$3"
  local result_file="$4"
  local output_line="${tool_name}:${pid}:${log_file}"
  local found_pid
  local target_pid

  log_tool_progress "$tool_name" "Checking stop request (seed pid=$pid)"

  if ! targeted_tool "$tool_name"; then
    {
      echo "STATUS\tkept"
      echo "KEEP\t${output_line}"
    } > "$result_file"
    log_tool_progress "$tool_name" "Skipping; not selected by current target filter"
    return 0
  fi

  if ! [[ "$pid" =~ ^[0-9]+$ ]]; then
    {
      echo "STATUS\tskipped"
      echo "KEEP\t${output_line}"
      echo "MSG\tSkipping $tool_name (invalid pid: $pid)"
    } > "$result_file"
    log_tool_progress "$tool_name" "Skipping; invalid pid '$pid'"
    return 0
  fi

  local tool_pids=()
  while IFS= read -r found_pid; do
    [[ -z "${found_pid:-}" ]] && continue
    tool_pids+=("$found_pid")
  done < <(collect_tool_pids "$tool_name" "$pid")

  if [[ ${#tool_pids[@]} -eq 0 ]]; then
    {
      echo "STATUS\talready"
      echo "MSG\t$tool_name already stopped (seed pid=$pid)"
    } > "$result_file"
    log_tool_progress "$tool_name" "Already stopped; no matching processes found"
    return 0
  fi

  local valid_targets=()
  for target_pid in "${tool_pids[@]}"; do
    if safe_command_match "$tool_name" "$target_pid"; then
      valid_targets+=("$target_pid")
    fi
  done

  if [[ ${#valid_targets[@]} -eq 0 ]]; then
    {
      echo "STATUS\tskipped"
      echo "KEEP\t${output_line}"
      echo "MSG\tSkipping $tool_name (seed pid=$pid) due to command mismatch"
    } > "$result_file"
    log_tool_progress "$tool_name" "Skipping; matched processes failed command safety checks"
    return 0
  fi

  log_tool_progress "$tool_name" "Attempting graceful stop for ${#valid_targets[@]} matching process(es)"

  # Kill children first, then parent-like entries, to avoid orphaned workers.
  local i
  for ((i=${#valid_targets[@]}-1; i>=0; i--)); do
    kill -HUP "${valid_targets[$i]}" 2>/dev/null || true
  done

  # Wait briefly for graceful shutdown.
  local any_alive
  local _
  for _ in {1..20}; do
    any_alive=0
    for target_pid in "${valid_targets[@]}"; do
      if kill -0 "$target_pid" 2>/dev/null; then
        any_alive=1
        break
      fi
    done
    if [[ $any_alive -eq 0 ]]; then
      break
    fi
    sleep 0.1
  done

  log_tool_progress "$tool_name" "Checking for any processes still alive after graceful stop"
  for target_pid in "${valid_targets[@]}"; do
    if kill -0 "$target_pid" 2>/dev/null; then
      log_tool_progress "$tool_name" "Force killing remaining pid $target_pid"
      kill -9 "$target_pid" 2>/dev/null || true
    fi
  done

  {
    echo "STATUS\tterminated"
    echo "MSG\tStopped $tool_name (seed pid=$pid, matched=${#valid_targets[@]})"
  } > "$result_file"
  log_tool_progress "$tool_name" "Stop sequence complete"
}

while IFS=: read -r tool_name pid log_file; do
  if [[ -z "${tool_name:-}" || -z "${pid:-}" ]]; then
    continue
  fi

  result_file="$results_dir/result_$job_index"
  process_tool_entry "$tool_name" "$pid" "$log_file" "$result_file" &
  job_pids+=("$!")
  ((job_index += 1))
done < "$PID_FILE"

for job_pid in "${job_pids[@]}"; do
  if ! wait "$job_pid"; then
    echo "A stop worker exited unexpectedly" >&2
  fi
done

if [[ -d "$results_dir" ]]; then
  while IFS= read -r result_file; do
    [[ -f "$result_file" ]] || continue
    while IFS=$'\t' read -r kind value; do
      case "$kind" in
        STATUS)
          case "$value" in
            terminated)
              ((terminated += 1))
              ;;
            already)
              ((already_stopped += 1))
              ;;
            skipped)
              ((skipped += 1))
              ;;
            kept)
              ((kept += 1))
              ;;
          esac
          ;;
        KEEP)
          echo "$value" >> "$tmp_pid_file"
          ;;
        MSG)
          echo "$value"
          ;;
      esac
    done < "$result_file"
  done < <(find "$results_dir" -type f -name 'result_*' | sort)
fi

rm -rf "$results_dir"

if [[ -s "$tmp_pid_file" ]]; then
  mv "$tmp_pid_file" "$PID_FILE"
else
  rm -f "$tmp_pid_file" "$PID_FILE"
fi
