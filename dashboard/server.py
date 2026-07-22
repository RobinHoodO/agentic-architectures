"""
Agentic Architectures Arena — dashboard + Codex bridge server (one process, port 8035).

  /v1/*      OpenAI-compatible API backed by `codex exec` (ChatGPT subscription)
  /api/*     dashboard API (architectures, runs, SSE progress, sweep)
  /          the Arena UI
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

import codex_shim

HERE = Path(__file__).resolve().parent

app = FastAPI(title="Agentic Architectures Arena")


@app.middleware("http")
async def no_store(request, call_next):
    """Dev dashboard: never let the browser cache UI assets or API responses
    (stale app.js after an upgrade looks like broken features)."""
    resp = await call_next(request)
    if not request.url.path.startswith("/v1"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


app.include_router(codex_shim.router)

try:
    import arena_runner  # noqa: E402  (needs the arena venv; shim works without it)
    app.include_router(arena_runner.router)
except Exception as e:  # pragma: no cover — surfaced in /api/health
    _runner_error = str(e)

    @app.get("/api/health")
    async def health_degraded():
        return {"ok": False, "runner_error": _runner_error, "shim": codex_shim.STATS}

static_dir = HERE / "static"
if static_dir.is_dir():
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")


def _disable_quickedit() -> None:
    """Windows console QuickEdit pauses the process when the user clicks the window —
    reads as a fake crash. Disable it for this console (same fix as video-editor)."""
    if os.name != "nt":
        return
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        h = kernel32.GetStdHandle(-10)  # STD_INPUT_HANDLE
        mode = ctypes.c_uint()
        if kernel32.GetConsoleMode(h, ctypes.byref(mode)):
            new_mode = (mode.value | 0x0080) & ~0x0040  # +EXTENDED_FLAGS, -QUICK_EDIT
            kernel32.SetConsoleMode(h, new_mode)
    except Exception:
        pass


if __name__ == "__main__":
    import uvicorn

    _disable_quickedit()
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("ARENA_PORT", "8035")))
