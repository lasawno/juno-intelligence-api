#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR/vibevoice-src"
PORT="${PORT:-8881}"

log() { echo "[vibevoice-setup] $*"; }

# ── 1. Clone VibeVoice repo ─────────────────────────────────────────────────
if [ ! -d "$SRC_DIR/.git" ]; then
  log "Cloning microsoft/VibeVoice..."
  rm -rf "$SRC_DIR"
  git clone --depth 1 https://github.com/microsoft/VibeVoice.git "$SRC_DIR"
else
  log "VibeVoice repo already present at $SRC_DIR"
fi

# ── 2. Install Python deps ──────────────────────────────────────────────────
if ! python3 -c "import vibevoice" 2>/dev/null; then
  log "Installing PyTorch (CPU)..."
  pip install -q torch torchaudio --index-url https://download.pytorch.org/whl/cpu

  log "Installing VibeVoice and dependencies..."
  pip install -q -e "$SRC_DIR[streamingtts]"

  log "Installing server deps..."
  pip install -q fastapi uvicorn scipy soundfile
else
  log "vibevoice already installed, skipping pip"
fi

# ── 3. Ensure server deps present regardless ───────────────────────────────
python3 -c "import fastapi, uvicorn" 2>/dev/null || pip install -q fastapi uvicorn

# ── 4. Show available voices ────────────────────────────────────────────────
VOICES_DIR="$SRC_DIR/demo/voices/streaming_model"
if [ -d "$VOICES_DIR" ]; then
  log "Available voices: $(ls "$VOICES_DIR"/*.pt 2>/dev/null | xargs -I{} basename {} .pt | tr '\n' ' ')"
else
  log "No voice presets found yet (will use defaults on first run)"
fi

# ── 5. Start the service ────────────────────────────────────────────────────
log "Starting VibeVoice service on port $PORT (device=${MODEL_DEVICE:-cpu})"
export PORT="$PORT"
exec python3 "$SCRIPT_DIR/server.py"
