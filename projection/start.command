#!/bin/bash
# start.command — launch the projection wall.
#
# Double-click this in Finder, or run it from a terminal. It starts the local
# bridge (which owns the microphone and serves the page) and opens the browser.
# Nothing else is required: no build step, no internet, no external services.
#
# Ctrl-C in this window, or just close it, to stop.

cd "$(dirname "$0")" || exit 1
PORT=8092

echo "── Projection wall ─────────────────────────────"

# The Swift capture tool holds the microphone permission so the browser never
# has to ask. Build it if it is missing — this only happens once.
if [ ! -x bridge/miccap ]; then
  echo "building the audio capture tool (one time)…"
  if ! command -v swiftc >/dev/null 2>&1; then
    echo "  swiftc not found — install Xcode command line tools:"
    echo "    xcode-select --install"
    echo "  The wall still runs without it, just with no live audio."
  else
    swiftc -O -o bridge/miccap bridge/miccap.swift || \
      echo "  build failed — the wall will run without live audio."
  fi
fi

# Refuse to start twice on the same port; a second copy would fight the first
# for the microphone and neither would work properly.
if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "already running on port $PORT — opening the browser."
  open "http://localhost:$PORT/"
  exit 0
fi

echo "starting on http://localhost:$PORT/"
node bridge/serve.js $PORT &
SERVER_PID=$!

# Stop the server when this window closes, rather than leaving it orphaned.
trap 'kill $SERVER_PID 2>/dev/null' EXIT INT TERM

sleep 2
open "http://localhost:$PORT/"

cat <<'KEYS'

  On the projector
    F          fullscreen
    C          alignment handles      \  switch between paintings
    P          preview off  ← do this before projecting
    H          hide the text
    , .        brightness

  Running
    S          restart the piece      B  jump to the climax
    G g        noise gate

  Keep the Mac awake:  caffeinate -d

KEYS

wait $SERVER_PID
