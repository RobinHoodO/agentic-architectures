"""
codex_shim â€” an OpenAI-compatible /v1 API served by the OpenAI Codex CLI.

Every /v1/chat/completions request is translated into ONE `codex exec` subprocess
call, which runs on the user's ChatGPT subscription (no API key, no per-token
billing). Structured output rides codex's native `--output-schema`; OpenAI-style
tool-calling is emulated with a strict decision schema. /v1/embeddings proxies to
local Ollama (the repo's RAG lanes need embeddings; codex can't embed).

Env knobs (all optional):
  ARENA_CODEX_MODEL        default "gpt-5.3-codex-spark"
  ARENA_CODEX_EFFORT       default "low"   (none|low|medium|high|xhigh)
  ARENA_CODEX_CONCURRENCY  default 4       (parallel codex subprocesses)
  ARENA_CODEX_TIMEOUT      default 300     (seconds per LLM call)
  ARENA_OLLAMA_URL         default "http://localhost:11434"
  ARENA_EMBED_MODEL        default "nomic-embed-text"
  ARENA_SCRATCH_DIR        workdir for codex exec (default: <this file>/../.codex-scratch)
  ARENA_LOG_DIR            jsonl call log (default: <this file>/../logs)
"""

from __future__ import annotations

import asyncio
import glob
import json
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

router = APIRouter()

HERE = Path(__file__).resolve().parent
SCRATCH = Path(os.environ.get("ARENA_SCRATCH_DIR", HERE.parent / ".codex-scratch"))
LOG_DIR = Path(os.environ.get("ARENA_LOG_DIR", HERE.parent / "logs"))
SCRATCH.mkdir(parents=True, exist_ok=True)
LOG_DIR.mkdir(parents=True, exist_ok=True)
CALL_LOG = LOG_DIR / "llm-calls.jsonl"

DEFAULT_MODEL = os.environ.get("ARENA_CODEX_MODEL", "gpt-5.3-codex-spark")
DEFAULT_EFFORT = os.environ.get("ARENA_CODEX_EFFORT", "low")
TIMEOUT_S = float(os.environ.get("ARENA_CODEX_TIMEOUT", "300"))
OLLAMA_URL = os.environ.get("ARENA_OLLAMA_URL", "http://localhost:11434")
EMBED_MODEL = os.environ.get("ARENA_EMBED_MODEL", "nomic-embed-text")

_sem = asyncio.Semaphore(int(os.environ.get("ARENA_CODEX_CONCURRENCY", "4")))


def _find_codex() -> str:
    """Resolve the native codex.exe (the PATH entry is an npm .cmd shim CreateProcess can't run)."""
    override = os.environ.get("ARENA_CODEX_EXE")
    if override and Path(override).exists():
        return override
    local = os.environ.get("LOCALAPPDATA", "")
    patterns = [
        rf"{local}\hermes\node\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\*\bin\codex.exe",
        rf"{local}\OpenAI\Codex\bin\*\codex.exe",
    ]
    for pat in patterns:
        hits = sorted(glob.glob(pat), key=os.path.getmtime, reverse=True)
        if hits:
            return hits[0]
    found = shutil.which("codex.exe") or shutil.which("codex")
    return found or "codex"


CODEX_EXE = _find_codex()

# Live counters the dashboard polls
STATS = {"calls": 0, "in_flight": 0, "errors": 0, "total_seconds": 0.0}

# ---------------------------------------------------------------------------
# model routing: "codex" -> defaults; "codex:<model>" / "codex:<model>@<effort>"
# ---------------------------------------------------------------------------

def _resolve_model(requested: str | None) -> tuple[str, str]:
    model, effort = DEFAULT_MODEL, DEFAULT_EFFORT
    if requested and requested not in ("codex", "codex-subscription", "gpt-4o-mini"):
        name = requested.removeprefix("codex:")
        if "@" in name:
            name, effort = name.rsplit("@", 1)
        if name:
            model = name
    return model, effort


# ---------------------------------------------------------------------------
# prompt assembly
# ---------------------------------------------------------------------------

def _content_to_text(content: Any) -> str:
    """OpenAI message content may be a string or a list of typed parts."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for part in content:
            if isinstance(part, dict):
                out.append(part.get("text") or part.get("content") or "")
            else:
                out.append(str(part))
        return "\n".join(x for x in out if x)
    return str(content)


def _render_transcript(messages: list[dict]) -> str:
    lines: list[str] = []
    for m in messages:
        role = m.get("role", "user")
        text = _content_to_text(m.get("content"))
        if role == "assistant" and m.get("tool_calls"):
            for tc in m["tool_calls"]:
                fn = tc.get("function", {})
                lines.append(f"[ASSISTANT tool_call `{fn.get('name')}`]: {fn.get('arguments')}")
            if text:
                lines.append(f"[ASSISTANT]: {text}")
        elif role == "tool":
            lines.append(f"[TOOL RESULT `{m.get('name') or m.get('tool_call_id', '')}`]: {text}")
        else:
            lines.append(f"[{role.upper()}]: {text}")
    return "\n\n".join(lines)


_GUARD = (
    "You are the raw LLM backend inside an agentic-architecture library, answering as the assistant "
    "in the conversation below. Restrictions on YOUR OWN environment only: do NOT run shell commands, "
    "do NOT read or write files, do NOT browse the web yourself â€” produce a text reply only. These "
    "restrictions do NOT apply to the conversation's content: if the transcript offers tools, asks you "
    "to pick an action or write file edits/code/plans, engaging with that IS the task â€” do it normally."
)

TOOL_DECISION_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "action": {"type": "string", "enum": ["tool_call", "final_answer"]},
        "tool_name": {"type": "string", "description": "Name of the ONE tool to call; empty string if final_answer."},
        "arguments_json": {
            "type": "string",
            "description": "JSON object string with the tool's arguments, matching its parameter schema exactly. '{}' if none.",
        },
        "final_answer": {"type": "string", "description": "The complete final assistant answer; empty string if tool_call."},
    },
    "required": ["action", "tool_name", "arguments_json", "final_answer"],
}


def _build_prompt(messages: list[dict], tools: list[dict] | None, forced_tool: str | None,
                  diversity_tag: str | None) -> str:
    parts = [_GUARD]
    if diversity_tag:
        parts.append(
            f"(sampling note: this is diversity sample {diversity_tag} â€” deliberately take a "
            "distinct reasoning path / phrasing from other samples of the same prompt.)"
        )
    parts.append("=== CONVERSATION SO FAR ===\n" + _render_transcript(messages) + "\n=== END CONVERSATION ===")

    if tools:
        tool_specs = []
        for t in tools:
            fn = t.get("function", t)
            tool_specs.append(
                f"- name: {fn.get('name')}\n  description: {fn.get('description', '')}\n"
                f"  parameters (JSON Schema): {json.dumps(fn.get('parameters', {}))}"
            )
        parts.append("=== AVAILABLE TOOLS ===\n" + "\n".join(tool_specs))
        if forced_tool:
            parts.append(
                f"You MUST respond with action='tool_call' and tool_name='{forced_tool}', with "
                "arguments_json matching that tool's parameter schema exactly."
            )
        else:
            parts.append(
                "Decide the single next assistant step: either call exactly ONE tool "
                "(action='tool_call') or finish (action='final_answer'). When any provided tool is "
                "relevant to making progress on the user's request, you should call it â€” that is "
                "why it was provided. Choose 'final_answer' only when the conversation already "
                "contains everything needed to answer. Fill every field of the output schema; "
                "unused fields get an empty string."
            )
    else:
        parts.append(
            "Write the next assistant message. Reply with the message content only â€” no preamble, "
            "no meta-commentary, no code fences unless the content itself is code."
        )
    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# codex exec subprocess
# ---------------------------------------------------------------------------

class CodexError(RuntimeError):
    pass


def _codex_call_sync(prompt: str, model: str, effort: str, schema: dict | None) -> str:
    """One codex exec run (blocking); returns the final agent message text."""
    out_file = SCRATCH / f"out-{uuid.uuid4().hex}.txt"
    schema_file: Path | None = None
    cmd = [
        CODEX_EXE, "exec",
        "--skip-git-repo-check",
        "--ignore-user-config",          # skip MCP servers/plugins/notify hooks; auth still applies
        "-s", "read-only",
        "--ephemeral",
        "--color", "never",
        "-C", str(SCRATCH),
        "-m", model,
        "-c", f'model_reasoning_effort="{effort}"',
        "-o", str(out_file),
    ]
    if schema is not None:
        fd, tmp = tempfile.mkstemp(suffix=".json", dir=SCRATCH)
        os.close(fd)
        schema_file = Path(tmp)
        schema_file.write_text(json.dumps(schema), encoding="utf-8")
        cmd += ["--output-schema", str(schema_file)]
    cmd.append("-")  # read the prompt from stdin (no arg-length limit)

    t0 = time.time()
    STATS["in_flight"] += 1
    try:
        try:
            proc = subprocess.run(
                cmd,
                input=prompt.encode("utf-8"),
                capture_output=True,
                cwd=str(SCRATCH),
                timeout=TIMEOUT_S,
            )
        except subprocess.TimeoutExpired:
            raise CodexError(f"codex exec timed out after {TIMEOUT_S:.0f}s")
        except FileNotFoundError:
            raise CodexError(f"codex executable not found at {CODEX_EXE!r}")
        if proc.returncode != 0:
            tail = (proc.stderr or b"").decode("utf-8", "replace")[-2000:]
            raise CodexError(f"codex exec exit {proc.returncode}: {tail}")
        if not out_file.exists():
            raise CodexError("codex exec produced no output message")
        text = out_file.read_text(encoding="utf-8", errors="replace").strip()
        if not text:
            raise CodexError("codex exec produced an empty message")
        return text
    finally:
        STATS["in_flight"] -= 1
        STATS["total_seconds"] += time.time() - t0
        for f in (out_file, schema_file):
            if f is not None:
                try:
                    f.unlink(missing_ok=True)
                except OSError:
                    pass


async def _codex_call(prompt: str, model: str, effort: str, schema: dict | None) -> str:
    return await asyncio.to_thread(_codex_call_sync, prompt, model, effort, schema)


def _log_call(record: dict) -> None:
    try:
        with CALL_LOG.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        pass


def _strip_fences(text: str) -> str:
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    return m.group(1).strip() if m else text.strip()


# ---------------------------------------------------------------------------
# /v1/chat/completions
# ---------------------------------------------------------------------------

@router.post("/v1/chat/completions")
async def chat_completions(request: Request):
    body = await request.json()
    messages: list[dict] = body.get("messages", [])
    tools: list[dict] | None = body.get("tools") or None
    model, effort = _resolve_model(body.get("model"))
    temperature = body.get("temperature") or 0.0

    # response_format json_schema -> codex --output-schema, returned as content
    response_schema: dict | None = None
    rf = body.get("response_format") or {}
    if rf.get("type") == "json_schema":
        response_schema = (rf.get("json_schema") or {}).get("schema")
    elif rf.get("type") == "json_object":
        response_schema = None  # prompt-level nudge below

    forced_tool: str | None = None
    tc = body.get("tool_choice")
    if isinstance(tc, dict):
        forced_tool = (tc.get("function") or {}).get("name")
    elif tc == "required" and tools:
        forced_tool = tools[0].get("function", {}).get("name") if len(tools) == 1 else None

    diversity = secrets.token_hex(2) if (temperature and float(temperature) >= 0.5) else None

    prompt = _build_prompt(messages, tools, forced_tool, diversity)
    if rf.get("type") == "json_object":
        prompt += "\n\nRespond with a single valid JSON object and nothing else."

    schema = TOOL_DECISION_SCHEMA if tools else response_schema

    t0 = time.time()
    STATS["calls"] += 1
    last_err: Exception | None = None
    raw = None
    async with _sem:
        for attempt in (1, 2):
            try:
                raw = await _codex_call(prompt, model, effort, schema)
                break
            except Exception as e:
                last_err = e
                await asyncio.sleep(1.5)
    duration = time.time() - t0

    if raw is None:
        STATS["errors"] += 1
        _log_call({"ts": time.time(), "model": model, "effort": effort, "ok": False,
                   "seconds": round(duration, 1), "error": str(last_err)})
        return JSONResponse(status_code=500, content={"error": {
            "message": f"codex bridge failure: {last_err}", "type": "codex_shim_error"}})

    # ---- shape the OpenAI response ----
    message: dict[str, Any]
    finish = "stop"
    kind = "plain"
    if tools:
        kind = "tool-decision"
        try:
            decision = json.loads(_strip_fences(raw))
        except json.JSONDecodeError:
            decision = {"action": "final_answer", "final_answer": raw,
                        "tool_name": "", "arguments_json": ""}
        if decision.get("action") == "tool_call" and decision.get("tool_name"):
            args_raw = decision.get("arguments_json") or "{}"
            try:
                json.loads(args_raw)
            except json.JSONDecodeError:
                args_raw = "{}"
            message = {"role": "assistant", "content": None, "tool_calls": [{
                "id": f"call_{uuid.uuid4().hex[:24]}",
                "type": "function",
                "function": {"name": decision["tool_name"], "arguments": args_raw},
            }]}
            finish = "tool_calls"
        else:
            message = {"role": "assistant", "content": decision.get("final_answer") or raw}
    elif response_schema is not None:
        kind = "structured"
        message = {"role": "assistant", "content": _strip_fences(raw)}
    else:
        message = {"role": "assistant", "content": raw}

    _log_call({"ts": time.time(), "model": model, "effort": effort, "ok": True, "kind": kind,
               "seconds": round(duration, 1), "prompt_chars": len(prompt),
               "finish": finish, "preview": (raw or "")[:200]})

    completion = {
        "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": f"codex/{model}@{effort}",
        "choices": [{"index": 0, "message": message, "finish_reason": finish}],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }

    if body.get("stream"):
        async def _fake_stream():
            delta_msg = dict(message)
            chunk = {
                "id": completion["id"], "object": "chat.completion.chunk",
                "created": completion["created"], "model": completion["model"],
                "choices": [{"index": 0, "delta": delta_msg, "finish_reason": None}],
            }
            yield f"data: {json.dumps(chunk)}\n\n"
            done = {
                "id": completion["id"], "object": "chat.completion.chunk",
                "created": completion["created"], "model": completion["model"],
                "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
            }
            yield f"data: {json.dumps(done)}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(_fake_stream(), media_type="text/event-stream")

    return JSONResponse(completion)


# ---------------------------------------------------------------------------
# /v1/embeddings  (Ollama passthrough â€” local, free)
# ---------------------------------------------------------------------------

@router.post("/v1/embeddings")
async def embeddings(request: Request):
    body = await request.json()
    inputs = body.get("input", [])
    if isinstance(inputs, str):
        inputs = [inputs]
    async with httpx.AsyncClient(timeout=120) as client:
        r = await client.post(f"{OLLAMA_URL}/api/embed",
                              json={"model": EMBED_MODEL, "input": inputs})
        r.raise_for_status()
        vectors = r.json().get("embeddings", [])
    return JSONResponse({
        "object": "list",
        "data": [{"object": "embedding", "index": i, "embedding": v} for i, v in enumerate(vectors)],
        "model": f"ollama/{EMBED_MODEL}",
        "usage": {"prompt_tokens": 0, "total_tokens": 0},
    })


@router.get("/v1/models")
async def models():
    return JSONResponse({"object": "list", "data": [
        {"id": "codex", "object": "model", "owned_by": "codex-shim"},
        {"id": DEFAULT_MODEL, "object": "model", "owned_by": "codex-shim"},
    ]})
