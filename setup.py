#!/usr/bin/env python3
"""
One-shot setup for the Agentic Architectures Arena.

    python setup.py              # full setup (includes Playwright Chromium for BrowserAgent)
    python setup.py --no-browser # skip the Chromium download (~130 MB)

What it does, in order:
  1. checks Python >= 3.10, git, the Codex CLI (and its login), Ollama
  2. clones FareedKhan-dev/all-agentic-architectures into ./arena at the pinned commit
  3. copies our teaching patches from ./overrides over the clone (see README for what/why)
  4. creates ./.venv and installs the library + dashboard dependencies into it
  5. pulls the local embedding model into Ollama (nomic-embed-text)

Safe to re-run: every step is idempotent.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ARENA = HERE / "arena"
VENV = HERE / ".venv"
UPSTREAM = "https://github.com/FareedKhan-dev/all-agentic-architectures"
PINNED_COMMIT = "cf9d620a8cc55d59589399c30f305e6dfaa428ec"
EMBED_MODEL = "nomic-embed-text"

OK, WARN, FAIL = "[ ok ]", "[warn]", "[FAIL]"


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    # utf-8 + replace: child output (git/uv progress bars) must never crash the reader
    return subprocess.run(cmd, text=True, capture_output=True,
                          encoding="utf-8", errors="replace", **kw)


def venv_python() -> Path:
    return VENV / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")


def step_checks() -> bool:
    ok = True
    if sys.version_info < (3, 10):
        print(f"{FAIL} Python 3.10+ required (you have {sys.version.split()[0]}). Install 3.12 and re-run.")
        ok = False
    elif sys.version_info >= (3, 14):
        print(f"{FAIL} Python {sys.version.split()[0]} is newer than the tested band (3.10-3.13) — "
              "binary wheels for faiss/uvloop may not exist yet. Install 3.12 and re-run.")
        ok = False
    else:
        print(f"{OK} Python {sys.version.split()[0]}")

    if shutil.which("git"):
        print(f"{OK} git found")
    else:
        print(f"{FAIL} git not found on PATH — install git and re-run.")
        ok = False

    codex = shutil.which("codex")
    if codex:
        login = run(["codex", "login", "status"], shell=(sys.platform == "win32"))
        if "logged in" in (login.stdout + login.stderr).lower():
            print(f"{OK} Codex CLI found and logged in")
        else:
            print(f"{WARN} Codex CLI found but NOT logged in — run `codex login` before starting the Arena.")
    else:
        print(f"{FAIL} Codex CLI not found. Install it (https://developers.openai.com/codex/cli) and run `codex login`.")
        ok = False

    try:
        urllib.request.urlopen("http://localhost:11434/api/tags", timeout=3)
        print(f"{OK} Ollama reachable on :11434")
    except Exception:
        print(f"{WARN} Ollama not reachable on :11434 — the 9 RAG/memory patterns need it for local")
        print("       embeddings (https://ollama.com). The other 27 patterns work without it.")
    return ok


def step_clone() -> None:
    if (ARENA / "pyproject.toml").exists():
        print(f"{OK} arena/ already present — skipping clone")
    else:
        print(f"...  cloning {UPSTREAM} -> arena/")
        r = run(["git", "clone", UPSTREAM, str(ARENA)])
        if r.returncode != 0:
            sys.exit(f"{FAIL} git clone failed:\n{r.stderr}")
    r = run(["git", "-C", str(ARENA), "checkout", "--quiet", PINNED_COMMIT])
    if r.returncode != 0:
        sys.exit(f"{FAIL} could not checkout pinned commit {PINNED_COMMIT[:7]}:\n{r.stderr}")
    print(f"{OK} arena/ pinned to upstream commit {PINNED_COMMIT[:7]}")


def step_overrides() -> None:
    n = 0
    for src in (HERE / "overrides").rglob("*.py"):
        rel = src.relative_to(HERE / "overrides")
        dst = ARENA / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        n += 1
    print(f"{OK} applied {n} teaching patches from overrides/ (see README: 'What we changed')")


def step_venv(with_browser: bool) -> None:
    uv = shutil.which("uv")
    if not venv_python().exists():
        print("...  creating .venv" + (" (via uv)" if uv else ""))
        if uv:
            r = run([uv, "venv", str(VENV), "--seed"])
        else:
            # Some Pythons (uv-managed, Debian without python3-venv) lack ensurepip.
            r = run([sys.executable, "-m", "venv", str(VENV)])
        if r.returncode != 0:
            sys.exit(
                f"{FAIL} venv creation failed:\n{(r.stderr or r.stdout)[-1500:]}\n\n"
                "Your Python likely lacks venv/ensurepip. Easiest fixes:\n"
                "  - install uv (https://docs.astral.sh/uv) and re-run — setup will use it, or\n"
                "  - Debian/Ubuntu: sudo apt install python3-venv, or\n"
                "  - install Python 3.12 from python.org and re-run with it."
            )
    py = str(venv_python())
    print("...  installing dependencies (a few minutes on first run)")
    deps = ["-e", str(ARENA) + "[openai,ollama,faiss,networkx,science,tavily]",
            "fastapi", "uvicorn[standard]", "httpx", "playwright"]
    if uv:
        r = run([uv, "pip", "install", "--quiet", "--python", py, *deps])
    else:
        run([py, "-m", "pip", "install", "--upgrade", "pip", "--quiet"])
        r = run([py, "-m", "pip", "install", "--quiet", *deps])
    if r.returncode != 0:
        sys.exit(f"{FAIL} dependency install failed:\n{(r.stderr or r.stdout)[-3000:]}")
    print(f"{OK} dependencies installed into .venv")
    if with_browser:
        print("...  installing Playwright Chromium for BrowserAgent (~130 MB; --no-browser to skip)")
        if sys.platform.startswith("linux"):
            # Linux needs system libraries too; --with-deps uses apt/sudo and may prompt.
            r = run([py, "-m", "playwright", "install", "--with-deps", "chromium"])
            if r.returncode != 0:
                r = run([py, "-m", "playwright", "install", "chromium"])
                if r.returncode == 0:
                    print(f"{WARN} Chromium installed, but system deps may be missing — if BrowserAgent "
                          f"fails to launch, run: sudo {py} -m playwright install-deps chromium")
        else:
            r = run([py, "-m", "playwright", "install", "chromium"])
        print(f"{OK} Chromium installed" if r.returncode == 0
              else f"{WARN} Chromium install failed — only the BrowserAgent card is affected:\n{(r.stderr or r.stdout)[-500:]}")


def step_embed_model() -> None:
    try:
        with urllib.request.urlopen("http://localhost:11434/api/tags", timeout=3) as resp:
            if EMBED_MODEL.split(":")[0] in resp.read().decode("utf-8", "replace"):
                print(f"{OK} Ollama embedding model '{EMBED_MODEL}' already present")
                return
    except Exception:
        print(f"{WARN} skipping embedding-model pull (Ollama not reachable)")
        return
    if not shutil.which("ollama"):
        print(f"{WARN} Ollama server is up but the `ollama` CLI isn't on PATH — "
              f"pull the model yourself: ollama pull {EMBED_MODEL}")
        return
    print(f"...  pulling '{EMBED_MODEL}' into Ollama (~270 MB, one-off)")
    r = run(["ollama", "pull", EMBED_MODEL], shell=(sys.platform == "win32"))
    print(f"{OK} embedding model ready" if r.returncode == 0
          else f"{WARN} ollama pull failed — RAG/memory patterns will error until you run: ollama pull {EMBED_MODEL}")


def main() -> None:
    with_browser = "--no-browser" not in sys.argv
    print("=== Agentic Architectures Arena — setup ===\n")
    if not step_checks():
        sys.exit("\nFix the [FAIL] items above and re-run:  python setup.py")
    step_clone()
    step_overrides()
    step_venv(with_browser)
    step_embed_model()
    print("\n=== Done. Start the dashboard: ===")
    if sys.platform == "win32":
        print("    Start-Arena.bat        (or double-click it)")
    else:
        print("    ./start.sh")
    print("then open http://127.0.0.1:8035/\n")


if __name__ == "__main__":
    main()
