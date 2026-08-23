#!/usr/bin/env bash
# Start the Agentic Architectures Arena (macOS / Linux).
set -e
cd "$(dirname "$0")"
PORT="${ARENA_PORT:-8035}"

# OpenRouter key for embeddings (shim falls back to local Ollama if absent)
if [ -z "$OPENROUTER_API" ] && [ -f "/Users/robinsverd/Thrivbe-AI/Thrivbe-OS/.env" ]; then
    export "$(grep -m1 '^OPENROUTER_API=' /Users/robinsverd/Thrivbe-AI/Thrivbe-OS/.env)"
fi
if [ -n "$OPENROUTER_API" ]; then
    # route the arena library's embeddings through the shim → OpenRouter (not Ollama)
    export EMBEDDINGS_PROVIDER=openai
    export EMBEDDINGS_MODEL=text-embedding-3-small
fi

if [ ! -x ".venv/bin/python" ]; then
    echo "[arena] No .venv found - run setup first:   python3 setup.py"
    exit 1
fi

# free the port if a stale server is listening
if command -v lsof >/dev/null 2>&1; then
    PIDS=$(lsof -ti tcp:"$PORT" || true)
    if [ -n "$PIDS" ]; then
        echo "[arena] freeing port $PORT (pid $PIDS)"
        kill -9 $PIDS 2>/dev/null || true
    fi
fi

if ! codex login status 2>/dev/null | grep -qi "logged in"; then
    echo "[arena] WARNING: Codex CLI not logged in. Run:  codex login"
fi

( sleep 3
  URL="http://127.0.0.1:$PORT/"
  command -v open >/dev/null 2>&1 && open "$URL" || xdg-open "$URL" 2>/dev/null || true ) &

echo "[arena] starting server on http://127.0.0.1:$PORT/  (Ctrl+C to stop)"
exec .venv/bin/python dashboard/server.py
