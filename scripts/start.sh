#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_FILE="$PROJECT_DIR/logs/brainifai.log"
mkdir -p "$PROJECT_DIR/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

# --- PATH: cover Homebrew (Intel + ARM) and common node managers ---
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# nvm support
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  . "$NVM_DIR/nvm.sh" --no-use
  nvm use default 2>/dev/null || true
fi

cd "$PROJECT_DIR"

log "Starting ingestion..."
npm run ingest >> "$LOG_FILE" 2>&1 || {
  EXIT_CODE=$?
  # Exit 139 = Kuzu SIGSEGV on cleanup, data was still written successfully
  if [ "$EXIT_CODE" -eq 139 ]; then
    log "Ingestion completed (Kuzu cleanup segfault, non-fatal)"
  else
    log "Ingestion failed with exit code $EXIT_CODE"
  fi
}
log "Ingestion finished."
