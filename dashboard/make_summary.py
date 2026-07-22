"""Generate results/SWEEP.md from results/results.json (run after a sweep).

Run with the venv Python from anywhere:  .venv/bin/python dashboard/make_summary.py
(Windows: .venv\\Scripts\\python dashboard\\make_summary.py)
"""
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))  # import arena_runner regardless of cwd

from arena_runner import CATALOG, FAMILIES  # noqa: E402

RESULTS = HERE.parent / "results" / "results.json"
OUT = HERE.parent / "results" / "SWEEP.md"

data = json.loads(RESULTS.read_text(encoding="utf-8"))
counts = {"pass": 0, "fail": 0, "error": 0}
for v in data.values():
    counts[v["status"]] = counts.get(v["status"], 0) + 1

lines = [
    "# Arena sweep — all 36 runnable classes (35 patterns) on Codex CLI",
    "",
    f"Generated {time.strftime('%Y-%m-%d %H:%M')} · LLM = codex exec (ChatGPT subscription) · "
    f"embeddings = Ollama {os.environ.get('ARENA_EMBED_MODEL', 'nomic-embed-text')}",
    "",
    f"**{counts['pass']}/{len(data)} checks-pass** · {counts['fail']} checks-fail · {counts['error']} error",
    "",
    "| # | Architecture | Family | Result | Time | LLM calls | Model |",
    "|---|---|---|---|---|---|---|",
]
mark = {"pass": "✅ pass", "fail": "⚠️ checks-fail", "error": "❌ error", "stopped": "⏹ stopped"}
for cls, spec in sorted(CATALOG.items(), key=lambda kv: (kv[1]["num"], kv[0])):
    r = data.get(cls)
    if not r:
        lines.append(f"| {spec['num']} | {cls} | {spec['family_label']} | — not run | | | |")
        continue
    lines.append(
        f"| {spec['num']} | {cls} | {spec['family_label']} | {mark[r['status']]} | "
        f"{r['seconds']}s | {r['llm_calls']} | {r.get('model','')}@{r.get('effort','')} |"
    )

lines += [
    "",
    "## Reading the fails",
    "",
    "The repo's own leaderboard documents pattern-fit failures — a pattern applied to the wrong task",
    "shape fails honestly. Persistent fails here match that list (Reflexion / AgentWorkflowMemory on",
    "raw-fact recall; Ensemble group-think on the Sally trick) plus word-level check strictness",
    "(answers correct but missing a literal keyword). Details per run: results.json + the dashboard.",
    "",
]
OUT.write_text("\n".join(lines), encoding="utf-8")
print(f"wrote {OUT} — {counts}")
