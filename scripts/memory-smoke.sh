#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$HOME/.nvm/nvm.sh" ]]; then
  set +e
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1090
  . "$HOME/.nvm/nvm.sh"
  nvm use 22 >/dev/null
  nvm_status=$?
  set -e
  if [[ $nvm_status -ne 0 ]]; then
    echo "nvm use 22 failed (exit=$nvm_status)." >&2
    exit 1
  fi
else
  echo "nvm was not found at $HOME/.nvm" >&2
  exit 1
fi

echo "Using Node $(node -v)"

echo "Rebuilding better-sqlite3 for current Node runtime..."
(cd "$ROOT_DIR" && pnpm rebuild better-sqlite3)

echo "Running memory smoke test..."
(
  cd "$ROOT_DIR"
  GLOVE_CONFIG_DIR="$ROOT_DIR/config" \
  GLOVE_SECRETS_DIR="$ROOT_DIR/secrets" \
  pnpm --filter @langgraph-glove/tool-memory smoke
)

echo "Memory smoke test completed successfully."
