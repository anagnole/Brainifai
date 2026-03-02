#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_FILE="$PROJECT_DIR/logs/brainifai.log"
mkdir -p "$PROJECT_DIR/logs"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

# --- PATH: cover Homebrew (Intel + ARM) and common node managers ---
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# nvm support
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  . "$NVM_DIR/nvm.sh" --no-use
  nvm use default 2>/dev/null || true
fi

# --- 1. Ensure Docker Desktop is running ---
if ! docker info >/dev/null 2>&1; then
  log "Starting Docker Desktop..."
  open -a Docker
  for i in $(seq 1 60); do
    docker info >/dev/null 2>&1 && break
    log "Waiting for Docker... ($i/60)"
    sleep 2
  done
fi

# --- 2. Start Neo4j ---
log "Starting Neo4j..."
cd "$PROJECT_DIR"
docker compose up -d

# --- 3. Wait for Neo4j healthy ---
log "Waiting for Neo4j healthcheck..."
for i in $(seq 1 30); do
  STATUS=$(docker inspect --format='{{.State.Health.Status}}' brainifai-neo4j 2>/dev/null || echo "missing")
  [ "$STATUS" = "healthy" ] && { log "Neo4j ready."; break; }
  log "Neo4j status: $STATUS ($i/30)"
  sleep 3
done

# --- 4. Hand off to UI server (exec: launchd tracks this PID) ---
log "Starting UI..."
exec npm --prefix "$PROJECT_DIR/ui" run dev
