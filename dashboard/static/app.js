/* Agentic Architectures Arena — vanilla JS, no build step */
"use strict";

const $ = (id) => document.getElementById(id);
let CATALOG = {};      // class -> spec
let FAMILIES = {};
let RESULTS = {};      // class -> last result summary
let current = null;    // selected class name
let es = null;         // active EventSource
let currentRunId = null;
let viewRunId = null;  // run whose trace the drawer currently shows
let viewCalls = null;  // cached call details for finished/history runs
let graphState = { nodes: [], edges: [], pos: {} };
let lastGraphJson = null;  // last topology drawn — reused to reset the graph on re-run
let nodeStats = {};   // node -> {visits, calls, seconds}
let edgeCounts = {};  // "from→to" -> traversal count
let lastNode = null;

/* ---------------- catalog ---------------- */

async function loadCatalog() {
  const r = await fetch("/api/catalog");
  const data = await r.json();
  FAMILIES = data.families;
  RESULTS = data.results || {};
  CATALOG = {};
  for (const a of data.architectures) CATALOG[a.class] = a;

  const cat = $("catalog");
  cat.innerHTML = "";
  for (const [famKey, fam] of Object.entries(FAMILIES)) {
    const members = data.architectures.filter((a) => a.family === famKey);
    if (!members.length) continue;
    const sec = document.createElement("section");
    sec.className = "fam";
    sec.innerHTML = `<h2 style="color:${fam.color}">${fam.label}
      <span style="color:var(--dim);font-weight:600">${members.length}</span>
      <span class="rule" style="background:${fam.color}"></span></h2>`;
    const grid = document.createElement("div");
    grid.className = "grid";
    for (const a of members) grid.appendChild(makeCard(a));
    sec.appendChild(grid);
    cat.appendChild(sec);
  }
  refreshCards();
}

function makeCard(a) {
  const el = document.createElement("div");
  el.className = "card";
  el.id = "card-" + a.class;
  el.style.setProperty("--fam", a.color);
  const badges = (a.needs || []).map((n) => `<span class="badge">${n}</span>`).join("") +
    (a.expected_fail ? `<span class="badge kf" title="${esc(a.expected_fail)}">known-fail</span>` : "");
  el.innerHTML = `
    <div class="num">${a.num}</div>
    <div class="name">${a.class}</div>
    <div class="pat">${a.pattern}</div>
    <div class="foot"><span class="dot" id="dot-${a.class}"></span>
      <span id="stat-${a.class}">not tested</span><span style="flex:1"></span>${badges}</div>`;
  el.onclick = () => openDrawer(a.class);
  return el;
}

function refreshCards() {
  let pass = 0;
  for (const cls of Object.keys(CATALOG)) {
    const res = RESULTS[cls];
    const dot = $("dot-" + cls);
    const stat = $("stat-" + cls);
    if (!dot) continue;
    dot.className = "dot" + (res ? " " + res.status : "");
    stat.textContent = res
      ? (res.status === "error" ? "error" : `${res.status} · ${res.seconds}s · ${res.llm_calls} calls`)
      : "not tested";
    if (res && res.status === "pass") pass++;
  }
  $("s-pass").textContent = `${pass}/${Object.keys(CATALOG).length}`;
}

/* ---------------- drawer ---------------- */

function openDrawer(cls) {
  current = cls;
  const a = CATALOG[cls];
  document.querySelectorAll(".card.sel").forEach((c) => c.classList.remove("sel"));
  $("card-" + cls)?.classList.add("sel");
  const d = $("drawer");
  d.classList.add("open");
  d.style.setProperty("--fam", a.color);
  $("d-num").textContent = a.num;
  $("d-name").textContent = a.class;
  $("d-fam").textContent = a.family_label;
  $("d-pattern").textContent = a.pattern;
  $("d-ref").textContent = a.reference;
  $("d-explain").textContent = a.explain || "";
  $("d-usewhen").innerHTML = a.use_when ? `<b>Use it for:</b> ${esc(a.use_when)}` : "";
  $("d-example").textContent = a.example || "";
  $("d-exwrap").style.display = a.example ? "" : "none";
  $("d-exwrap").removeAttribute("open");
  $("explainbox").style.display = a.explain ? "" : "none";
  $("task").value = a.task;
  $("runstate").textContent = a.setup_prompts.length
    ? `runs ${a.setup_prompts.length} setup prompt(s) first (stateful pattern)` : "";
  $("verdict").textContent = "";
  $("verdict").className = "";
  $("feed").innerHTML = "";
  $("output").textContent = "—";
  $("metachips").innerHTML = "";
  $("runbtn").disabled = false;
  setStopVisible(false);
  viewRunId = null;
  viewCalls = null;
  closeNodeModal();
  hideKG();
  hideWorkspace();
  drawGraph(null);
  if (es) { es.close(); es = null; }   // stop streaming the previous card into this view

  restoreState(cls);
}

function setStopVisible(on) {
  const b = $("stopbtn");
  b.style.display = on ? "" : "none";
  if (on) { b.disabled = false; b.textContent = "■ STOP"; }
}

async function restoreState(cls) {
  // Server decides: live run -> attach (SSE replays from event 0); finished -> replay stored trace.
  defaultGraph(cls);                                   // topology shows immediately; runs animate over it
  try {
    const st = await (await fetch(`/api/arch/${cls}/state`)).json();
    if (current !== cls) return;                       // user already moved on
    if (st.live) { attachEvents(st.live, cls); return; }
    if (st.events && st.events.length) {
      viewRunId = st.summary ? st.summary.id : null;
      viewCalls = st.calls || [];
      replayEvents(st.events, cls);
      if (st.summary) showFinal(st.summary, true);
      if (st.kg) renderKG(st.kg);
      if (st.workspace) renderWorkspace(st.workspace);
      return;
    }
  } catch (e) { /* fall through to summary-only */ }
  const res = RESULTS[cls];                            // pre-feature runs: summary only
  if (current === cls && res && (res.output || res.error)) showFinal(res, true);
}

async function defaultGraph(cls) {
  try {
    const g = (await (await fetch(`/api/arch/${cls}/graph`)).json()).graph;
    // don't clobber a graph a replay/live run has already drawn
    if (current === cls && g && !graphState.nodes.length) drawGraph(g);
  } catch (e) { /* placeholder text stays */ }
}

function replayEvents(events, cls) {
  for (const ev of events) {
    if (ev.t === "final" || ev.t === "eos" || ev.t === "status") continue;
    handleEvent(ev, cls);
  }
}

$("d-close").onclick = () => {
  $("drawer").classList.remove("open");
  document.querySelectorAll(".card.sel").forEach((c) => c.classList.remove("sel"));
  current = null;
  if (es) { es.close(); es = null; }
};

/* ---------------- running ---------------- */

$("runbtn").onclick = async () => {
  if (!current) return;
  const body = {
    arch: current,
    task: $("task").value,
    model: $("model").value,
    effort: $("effort").value,
  };
  $("runbtn").disabled = true;
  $("feed").innerHTML = "";
  $("output").textContent = "—";
  $("metachips").innerHTML = "";
  $("verdict").textContent = "";
  $("verdict").className = "";
  // a re-run starts from a clean slate: previous KG/workspace go, graph resets to topology
  hideKG();
  hideWorkspace();
  viewCalls = null;
  if (lastGraphJson) drawGraph(lastGraphJson);
  const r = await fetch("/api/run", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await r.json();
  if (data.run_id) attachEvents(data.run_id, current);
  else feedLine(`<span class="err">failed to start: ${data.error || "?"}</span>`);
};

function attachEvents(runId, cls) {
  if (es) { es.close(); es = null; }
  currentRunId = runId;
  viewRunId = runId;
  viewCalls = null;      // live run: fetch call details fresh on node click
  $("runbtn").disabled = true;
  $("runstate").textContent = "running…";
  setStopVisible(true);
  es = new EventSource(`/api/run/${runId}/events`);
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (current === cls) handleEvent(ev, cls);
    if (ev.t === "final" || ev.t === "eos") {
      if (ev.t === "final") {
        RESULTS[cls] = ev.summary;
        refreshCards();
        if (current === cls) { viewCalls = null; showFinal(ev.summary, false); }
      }
      if (ev.t === "eos" && es) {
        es.close(); es = null;
        if (current === cls) {
          $("runbtn").disabled = false;
          $("runstate").textContent = "";
          setStopVisible(false);
        }
      }
    }
  };
  es.onerror = () => {
    if (es) { es.close(); es = null; }
    if (current === cls) { $("runbtn").disabled = false; setStopVisible(false); }
  };
}

function handleEvent(ev, cls) {
  const ts = `<span class="ts">[${(ev.ts ?? 0).toFixed ? ev.ts.toFixed(1) : ev.ts}s]</span>`;
  switch (ev.t) {
    case "status":
      feedLine(`${ts} <span class="dim">run ${ev.status}</span>`);
      setDot(cls, "running", "running…");
      break;
    case "graph":
      drawGraph(ev.graph);
      break;
    case "phase":
      feedLine(`${ts} <span class="node">■ ${esc(ev.label)}</span>`);
      break;
    case "node":
      feedLine(`${ts} <span class="node">▶ node ${esc(ev.node)}</span>`);
      bumpVisit(ev.node);
      setActiveNode(ev.node);
      break;
    case "llm_start":
      feedLine(`${ts} <span class="llm">LLM →</span> <span class="node">${esc(ev.node || "?")}</span> <span class="dim">${esc(trim(ev.preview, 110))}</span>`);
      if (ev.node) {
        bumpStat(ev.node, "calls", 1);
        setActiveNode(ev.node);
      }
      break;
    case "llm_end":
      feedLine(`${ts} <span class="llm">LLM ✓ ${ev.seconds}s</span> <span class="dim">${esc(trim(ev.preview, 110))}</span>`);
      if (activeNode && ev.seconds) bumpStat(activeNode, "seconds", ev.seconds);
      markActiveDone();
      break;
    case "llm_error":
      feedLine(`${ts} <span class="err">LLM ✗ ${esc(trim(ev.error, 200))}</span>`);
      if (activeNode) document.getElementById("gn-" + cssId(activeNode))?.classList.add("errored");
      break;
    case "tool_start":
      feedLine(`${ts} <span class="tool">TOOL → ${esc(ev.tool)}</span> <span class="dim">${esc(trim(ev.input, 100))}</span>`);
      break;
    case "tool_end":
      feedLine(`${ts} <span class="tool">TOOL ✓ ${ev.seconds}s</span> <span class="dim">${esc(trim(ev.preview, 100))}</span>`);
      break;
    case "final":
      if (ev.summary) finishGraph(ev.summary.status);
      if (ev.kg) renderKG(ev.kg);
      if (ev.workspace) renderWorkspace(ev.workspace);
      break;
  }
}

/* runtime annotation: node badges (visits · llm calls · seconds) + loop-edge traversal counts */

function bumpStat(node, key, amount) {
  const s = (nodeStats[node] ||= { visits: 0, calls: 0, seconds: 0 });
  s[key] += amount;
  updateBadge(node);
}

function bumpVisit(node) {
  bumpStat(node, "visits", 1);
  if (lastNode) {  // includes lastNode === node: a real self-loop traversal
    const key = lastNode + "→" + node;
    const known = graphState.edges.some((e) => e.source === lastNode && e.target === node);
    if (known) {
      edgeCounts[key] = (edgeCounts[key] || 0) + 1;
      updateEdge(lastNode, node, edgeCounts[key]);
    }
  }
  lastNode = node;
}

function updateBadge(node) {
  const el = document.getElementById("gnb-" + cssId(node));
  if (!el) return;
  const s = nodeStats[node];
  const parts = [];
  if (s.visits > 1) parts.push("×" + s.visits);
  if (s.calls) parts.push(s.calls + " llm");
  if (s.seconds >= 1) parts.push(Math.round(s.seconds) + "s");
  el.textContent = parts.join(" · ");
}

function updateEdge(from, to, count) {
  const id = `ge-${cssId(from)}__${cssId(to)}`;
  const path = document.getElementById(id);
  if (!path) return;
  path.classList.add("hot");
  path.style.strokeWidth = Math.min(1.5 + count * 0.8, 6);
  if (count >= 2) {
    let label = document.getElementById("gec-" + id);
    if (!label) {
      const NS = "http://www.w3.org/2000/svg";
      label = document.createElementNS(NS, "text");
      label.setAttribute("id", "gec-" + id);
      label.setAttribute("class", "gedgecount");
      try {
        const m = path.getPointAtLength(path.getTotalLength() * 0.5);
        label.setAttribute("x", m.x + 6);
        label.setAttribute("y", m.y - 4);
      } catch (e) { return; }
      path.parentNode.appendChild(label);
    }
    label.textContent = "×" + count;
  }
}

function finishGraph(status) {
  // The flow reached the end only on pass/fail (checks verdicts); error/stopped halt mid-graph.
  markActiveDone();
  if (status === "pass" || status === "fail") {
    for (const t of ["__start__", "__end__"]) {
      document.getElementById("gn-" + cssId(t))?.classList.add("done");
    }
  }
}

function showFinal(sum, fromCache) {
  finishGraph(sum.status);
  $("output").textContent = pretty(sum.output) || (sum.error ? "(no output)" : "—");
  $("output").classList.remove("dim");
  const chips = [];
  if (fromCache) chips.push(`<span class="m">last run · <b>${esc(sum.when || "")}</b></span>`);
  chips.push(`<span class="m">time <b>${sum.seconds}s</b></span>`);
  chips.push(`<span class="m">LLM calls <b>${sum.llm_calls}</b></span>`);
  chips.push(`<span class="m">model <b>${esc(sum.model || "")}@${esc(sum.effort || "")}</b></span>`);
  for (const [k, v] of Object.entries(sum.metadata || {})) {
    chips.push(`<span class="m">${esc(k)} <b>${esc(trim(JSON.stringify(v), 40))}</b></span>`);
  }
  const xf = CATALOG[sum.arch] && CATALOG[sum.arch].expected_fail;
  if (sum.status === "fail" && xf) {
    chips.unshift(`<span class="m kf" title="${esc(xf)}">⚠ repo-documented pattern-fit fail — hover for why</span>`);
  }
  $("metachips").innerHTML = chips.join("");
  const v = $("verdict");
  if (sum.status === "stopped") {
    v.textContent = "⏹ STOPPED"; v.className = "stopped";
    if (!fromCache) feedLine(`<span class="dim">⏹ run stopped by user</span>`);
  } else if (sum.status === "error") {
    v.textContent = "ERROR"; v.className = "error";
    feedLine(`<span class="err">✗ ${esc(trim(sum.error, 300))}</span>`);
  } else if (sum.score) {
    v.textContent = sum.score.pass ? "✓ CHECKS PASS" : "✗ CHECKS FAIL";
    v.className = sum.score.pass ? "pass" : "fail";
    if (!sum.score.pass && !fromCache) {
      const why = [];
      if (sum.score.missing?.length) why.push("missing: " + sum.score.missing.join(", "));
      if (sum.score.banned_present?.length) why.push("banned: " + sum.score.banned_present.join(", "));
      if (Object.keys(sum.score.metadata_failed || {}).length) why.push("metadata: " + JSON.stringify(sum.score.metadata_failed));
      feedLine(`<span class="err">✗ ${esc(why.join(" · "))}</span>`);
    }
  }
  $("runstate").textContent = "";
  $("runbtn").disabled = false;
}

$("stopbtn").onclick = async () => {
  if (!viewRunId) return;
  $("stopbtn").disabled = true;
  $("stopbtn").textContent = "stopping…";
  try { await fetch(`/api/run/${viewRunId}/stop`, { method: "POST" }); } catch (e) { /* ignore */ }
};

/* ---------------- node inspector ---------------- */

async function openNodeModal(node) {
  let calls = viewCalls;
  if (!calls && viewRunId) {
    try {
      calls = (await (await fetch(`/api/run/${viewRunId}/calls`)).json()).calls || [];
    } catch (e) { calls = []; }
    if (!es) viewCalls = calls;   // cache once the run is no longer streaming
  }
  const mine = (calls || []).filter((c) => c.node === node);
  $("nm-title").textContent = node;
  $("nm-sub").textContent = mine.length ? `${mine.length} call(s) in this node` : "";
  const body = $("nm-body");
  body.innerHTML = mine.length
    ? mine.map(renderCall).join("")
    : `<div class="nm-empty">No LLM/tool calls recorded inside this node — it's a routing / pure-Python step (or this run predates call recording; re-run to capture full prompts).</div>`;
  document.querySelectorAll(".gnode.picked").forEach((g) => g.classList.remove("picked"));
  const g = document.getElementById("gn-" + cssId(node));
  if (g) g.classList.add("picked");
  $("nodemodal").classList.remove("nm-hidden");
  body.scrollTop = 0;
}

function renderCall(c) {
  const head = c.type === "tool"
    ? `TOOL <b>${esc(c.tool)}</b>${c.seconds != null ? ` · ${c.seconds}s` : ""}`
    : `LLM call <b>#${(c.index ?? 0) + 1}</b>${c.seconds != null ? ` · ${c.seconds}s` : ""}`;
  const req = (c.request || []).map((m) => {
    const tc = m.tool_calls
      ? `<pre class="nm-pre">${esc(JSON.stringify(m.tool_calls, null, 2))}</pre>` : "";
    return `<div class="nm-msg"><span class="nm-role r-${esc(m.role)}">${esc(m.role)}</span>` +
           `<pre class="nm-pre">${esc(pretty(m.content))}</pre>${tc}</div>`;
  }).join("");
  const resp = c.error
    ? `<div class="nm-msg"><span class="nm-role r-err">error</span><pre class="nm-pre">${esc(c.error)}</pre></div>`
    : (c.response != null && c.response !== ""
        ? `<div class="nm-msg"><span class="nm-role r-ai">response</span><pre class="nm-pre">${esc(pretty(c.response))}</pre></div>`
        : `<div class="nm-msg"><span class="nm-role">in flight…</span></div>`);
  return `<div class="nm-call"><div class="nm-callhead">${head}</div>${req}${resp}</div>`;
}

function closeNodeModal() {
  $("nodemodal").classList.add("nm-hidden");
  document.querySelectorAll(".gnode.picked").forEach((g) => g.classList.remove("picked"));
}
$("nm-close").onclick = closeNodeModal;
$("nodemodal").onclick = (e) => { if (e.target.id === "nodemodal") closeNodeModal(); };
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("nodemodal").classList.contains("nm-hidden")) { closeNodeModal(); return; }
  if ($("drawer").classList.contains("open")) $("d-close").click();
});

function setDot(cls, status, label) {
  const dot = $("dot-" + cls);
  const stat = $("stat-" + cls);
  if (dot) dot.className = "dot " + status;
  if (stat && label) stat.textContent = label;
}

function feedLine(html) {
  const f = $("feed");
  const ln = document.createElement("span");
  ln.className = "ln";
  ln.innerHTML = html;
  f.appendChild(ln);
  f.scrollTop = f.scrollHeight;
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const trim = (s, n) => { s = String(s ?? "").replace(/\s+/g, " "); return s.length > n ? s.slice(0, n) + "…" : s; };

function pretty(text) {
  // JSON payloads render indented; anything else passes through untouched
  const t = String(text ?? "").trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try { return JSON.stringify(JSON.parse(t), null, 2); } catch (e) { /* not JSON */ }
  }
  return t;
}

/* ---------------- workspace viewer (blackboard / skills / recipes / memory tiers) ---------------- */

function hideWorkspace() {
  $("wssection").style.display = "none";
  $("wsbody").innerHTML = "";
}

const CELL_COLORS = { tree: "#43b97f", fire: "#e8763d", ash: "#8a9bb0", empty: "#232936" };

function renderWorkspace(ws) {
  if (!ws || !ws.items || !ws.items.length) { hideWorkspace(); return; }
  $("wssection").style.display = "";
  $("wstitle").innerHTML = `Workspace <span style="text-transform:none;letter-spacing:0;color:#58627599">${esc(ws.title || "")} · ${ws.items.length} item(s)</span>`;
  $("wsbody").innerHTML = ws.items.map((it) => {
    let body;
    if (it.grid) {
      body = `<div class="ws-grid">` + it.grid.map((row) =>
        `<div class="ws-gridrow">` + row.map((cell) => {
          const c = CELL_COLORS[String(cell).toLowerCase()] || "#4a9eed";
          return `<span class="ws-cell" style="background:${c}" title="${esc(cell)}"></span>`;
        }).join("") + `</div>`).join("") + `</div>`;
    } else {
      body = `<pre class="ws-pre${it.code ? " ws-code" : ""}">${esc(pretty(it.content || ""))}</pre>`;
    }
    return `
    <div class="ws-item">
      <div class="ws-head">
        <span class="ws-tag">${esc(it.tag || "")}</span>
        ${it.label ? `<b>${esc(it.label)}</b>` : ""}
      </div>
      ${body}
    </div>`;
  }).join("");
}

/* ---------------- knowledge-graph viewer (networkx archs) ---------------- */

const KG_COLORS = ["#4a9eed", "#43b97f", "#e8a33d", "#e85d8a", "#b07fe8", "#e8763d", "#8a9bb0", "#d64545"];
let kgView = null; // {nodes, edges, vb:[x,y,w,h]}

function hideKG() {
  $("kgsection").style.display = "none";
  $("kgsvg").innerHTML = "";
  $("kglegend").innerHTML = "";
  kgView = null;
}

function renderKG(kg) {
  if (!kg || !kg.nodes || !kg.nodes.length) { hideKG(); return; }
  $("kgsection").style.display = "";
  const W = 900, H = 560;
  const nodes = kg.nodes.map((n, i) => ({
    id: n.id, community: n.community,
    x: W / 2 + Math.cos(i * 2.399) * (120 + (i % 7) * 28),
    y: H / 2 + Math.sin(i * 2.399) * (90 + (i % 5) * 26),
    vx: 0, vy: 0, deg: 0,
  }));
  const byId = {};
  nodes.forEach((n) => (byId[n.id] = n));
  const edges = kg.edges.filter((e) => byId[e.source] && byId[e.target]);
  edges.forEach((e) => { byId[e.source].deg++; byId[e.target].deg++; });

  // force layout: repulsion + springs + center gravity, cooled
  const K = 90;
  for (let it = 0; it < 260; it++) {
    const cool = 1 - it / 260;
    for (let a = 0; a < nodes.length; a++) {
      for (let b = a + 1; b < nodes.length; b++) {
        const n1 = nodes[a], n2 = nodes[b];
        let dx = n1.x - n2.x, dy = n1.y - n2.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        const f = (K * K) / d2 * 0.5;
        const d = Math.sqrt(d2);
        n1.vx += (dx / d) * f; n1.vy += (dy / d) * f;
        n2.vx -= (dx / d) * f; n2.vy -= (dy / d) * f;
      }
    }
    for (const e of edges) {
      const s = byId[e.source], t = byId[e.target];
      const dx = t.x - s.x, dy = t.y - s.y;
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const f = (d - K) * 0.02;
      s.vx += (dx / d) * f; s.vy += (dy / d) * f;
      t.vx -= (dx / d) * f; t.vy -= (dy / d) * f;
    }
    for (const n of nodes) {
      n.vx += (W / 2 - n.x) * 0.002; n.vy += (H / 2 - n.y) * 0.002;
      n.x += Math.max(-9, Math.min(9, n.vx)) * cool;
      n.y += Math.max(-9, Math.min(9, n.vy)) * cool;
      n.vx *= 0.6; n.vy *= 0.6;
    }
  }

  kgView = { nodes, edges, byId, vb: [0, 0, W, H] };
  drawKGSvg();

  // legend for communities (GraphRAG)
  const comms = [...new Set(nodes.filter((n) => n.community !== undefined).map((n) => n.community))].sort();
  $("kglegend").innerHTML = comms.length
    ? `<b>${nodes.length} entities · ${edges.length} triples</b> · communities: ` +
      comms.map((c) => `<span class="kgc" style="background:${KG_COLORS[c % KG_COLORS.length]}"></span> ${c + 1}`).join(" ")
    : `<b>${nodes.length} entities · ${edges.length} triples</b>`;
}

function drawKGSvg() {
  const { nodes, edges, byId, vb } = kgView;
  const svg = $("kgsvg");
  svg.setAttribute("viewBox", vb.join(" "));
  const showLabels = edges.length <= 70;
  let html = "";
  for (const e of edges) {
    const s = byId[e.source], t = byId[e.target];
    const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
    html += `<line class="kgedge" x1="${s.x}" y1="${s.y}" x2="${t.x}" y2="${t.y}"><title>${esc(e.source)} —${esc(e.predicate)}→ ${esc(e.target)}</title></line>`;
    if (showLabels && e.predicate) html += `<text class="kglabel" x="${mx}" y="${my - 3}" text-anchor="middle">${esc(e.predicate)}</text>`;
  }
  for (const n of nodes) {
    const color = n.community !== undefined ? KG_COLORS[n.community % KG_COLORS.length] : "#4a9eed";
    const r = 5 + Math.min(n.deg, 8);
    html += `<g class="kgnode" data-id="${esc(n.id)}"><circle cx="${n.x}" cy="${n.y}" r="${r}" fill="${color}"></circle>` +
            `<text x="${n.x}" y="${n.y - r - 4}" text-anchor="middle">${esc(n.id)}</text></g>`;
  }
  svg.innerHTML = html;
  wireKGInteractions();
}

function wireKGInteractions() {
  const svg = $("kgsvg");
  const pt = (ev) => {
    const r = svg.getBoundingClientRect();
    const [vx, vy, vw, vh] = kgView.vb;
    return { x: vx + ((ev.clientX - r.left) / r.width) * vw, y: vy + ((ev.clientY - r.top) / r.height) * vh };
  };
  let dragNode = null, panning = false;
  svg.onmousedown = (ev) => {
    const g = ev.target.closest(".kgnode");
    if (g) { dragNode = kgView.byId[g.dataset.id]; }
    else { panning = true; }
    ev.preventDefault();
  };
  svg.onmousemove = (ev) => {
    if (dragNode) {
      const m = pt(ev);
      dragNode.x = m.x; dragNode.y = m.y;
      drawKGSvg();
    } else if (panning) {
      const r = svg.getBoundingClientRect();
      kgView.vb[0] -= (ev.movementX / r.width) * kgView.vb[2];
      kgView.vb[1] -= (ev.movementY / r.height) * kgView.vb[3];
      svg.setAttribute("viewBox", kgView.vb.join(" "));
    }
  };
  svg.onmouseup = svg.onmouseleave = () => { dragNode = null; panning = false; };
  svg.onwheel = (ev) => {
    ev.preventDefault();
    const m = pt(ev);
    const f = ev.deltaY > 0 ? 1.15 : 0.87;
    const [vx, vy, vw, vh] = kgView.vb;
    kgView.vb = [m.x - (m.x - vx) * f, m.y - (m.y - vy) * f, vw * f, vh * f];
    svg.setAttribute("viewBox", kgView.vb.join(" "));
  };
}

/* ---------------- graph ---------------- */

function drawGraph(graph) {
  const svg = $("graph");
  svg.innerHTML = `<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5"
    markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
    <path d="M 0 0 L 10 5 L 0 10 z" fill="#485060"/></marker></defs>`;
  $("gsub").textContent = graph
    ? "(click a node for its prompts & outputs · drag to pan · wheel to zoom · double-click to reset)"
    : "(loading topology…)";
  nodeStats = {}; edgeCounts = {}; lastNode = null; activeNode = null;
  if (!graph) {
    graphState = { nodes: [], edges: [], pos: {} }; lastGraphJson = null;
    svg.setAttribute("viewBox", "0 0 620 40");
    svg.style.maxWidth = "620px";
    return;
  }
  lastGraphJson = graph;

  // BFS layering from __start__
  const ids = graph.nodes.map((n) => n.id);
  const layer = {};
  const out = {};
  for (const e of graph.edges) (out[e.source] ||= []).push(e.target);
  const q = ["__start__"];
  layer["__start__"] = 0;
  while (q.length) {
    const u = q.shift();
    for (const v of out[u] || []) {
      if (layer[v] === undefined) { layer[v] = layer[u] + 1; q.push(v); }
    }
  }
  let maxL = 0;
  for (const id of ids) { if (layer[id] === undefined) layer[id] = 1; maxL = Math.max(maxL, layer[id]); }
  // push __end__ to the last layer
  if (layer["__end__"] !== undefined) { layer["__end__"] = maxL = Math.max(maxL, ...ids.filter(i => i !== "__end__").map(i => layer[i])) + 0; layer["__end__"] = maxL = maxL + 1; }

  const byLayer = {};
  for (const id of ids) (byLayer[layer[id]] ||= []).push(id);

  const width = Math.max(620, 150 * Math.max(...Object.values(byLayer).map((l) => l.length)));
  const rowH = 78, padY = 26;
  const height = padY * 2 + maxL * rowH + 30;
  // viewBox + fluid width: the graph scales to fit its column (no horizontal scroll)
  // and centers itself; wide graphs shrink, narrow ones stay native size.
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.style.maxWidth = width + "px";
  gNat = [width, height];
  gVb = [0, 0, width, height];
  wireGraphNav(svg);

  const pos = {};
  for (const [l, members] of Object.entries(byLayer)) {
    members.forEach((id, i) => {
      const x = ((i + 1) * width) / (members.length + 1);
      const y = padY + Number(l) * rowH;
      pos[id] = { x, y };
    });
  }
  graphState = { nodes: ids, edges: graph.edges, pos };

  const isTerminal = (id) => id === "__start__" || id === "__end__";
  const labelOf = (id) => (isTerminal(id) ? id.replaceAll("_", "") : id);
  const halfW = {};
  for (const id of ids) halfW[id] = Math.max(58, labelOf(id).length * 7.2 + 20) / 2;

  const NS = "http://www.w3.org/2000/svg";
  // edges first
  for (const e of graph.edges) {
    const a = pos[e.source], b = pos[e.target];
    if (!a || !b) continue;
    const self = e.source === e.target;
    const back = !self && layer[e.target] <= layer[e.source] && e.target !== "__end__";
    const p = document.createElementNS(NS, "path");
    let d;
    if (self) {
      // loop out of the node's right edge and back into it
      const hw = halfW[e.source];
      d = `M ${a.x + hw} ${a.y - 6} C ${a.x + hw + 46} ${a.y - 30}, ${a.x + hw + 46} ${a.y + 30}, ${a.x + hw + 2} ${a.y + 6}`;
    } else if (back) {
      const off = 70 + Math.abs(a.y - b.y) * 0.12;
      d = `M ${a.x + halfW[e.source]} ${a.y} C ${a.x + off + 60} ${a.y}, ${b.x + off + 60} ${b.y}, ${b.x + halfW[e.target] + 4} ${b.y}`;
    } else {
      d = `M ${a.x} ${a.y + 14} C ${a.x} ${(a.y + b.y) / 2}, ${b.x} ${(a.y + b.y) / 2}, ${b.x} ${b.y - 15}`;
    }
    p.setAttribute("d", d);
    p.setAttribute("id", `ge-${cssId(e.source)}__${cssId(e.target)}`);
    p.setAttribute("class", "gedge" + (e.conditional ? " cond" : "") + ((back || self) ? " back" : ""));
    svg.appendChild(p);
  }
  // nodes
  for (const id of ids) {
    const { x, y } = pos[id];
    const g = document.createElementNS(NS, "g");
    const terminal = isTerminal(id);
    g.setAttribute("class", "gnode" + (terminal ? " terminal" : ""));
    g.setAttribute("id", "gn-" + cssId(id));
    const label = labelOf(id);
    const w = halfW[id] * 2;
    g.innerHTML = `<rect x="${x - w / 2}" y="${y - 14}" width="${w}" height="28" rx="7"></rect>
      <text x="${x}" y="${y + 4}" text-anchor="middle">${esc(label)}</text>` +
      (terminal ? "" : `<text class="gbadge" id="gnb-${cssId(id)}" x="${x}" y="${y + 27}" text-anchor="middle"></text>`);
    if (!terminal) {
      g.style.cursor = "pointer";
      g.addEventListener("click", () => openNodeModal(id));
    }
    svg.appendChild(g);
  }
}

let activeNode = null;
const cssId = (s) => s.replace(/[^a-zA-Z0-9_-]/g, "_");

/* live-graph canvas navigation: drag background to pan, wheel to zoom, dblclick to reset */
let gNat = [620, 40];       // natural [w, h] of the current graph
let gVb = [0, 0, 620, 40];  // current viewBox

function wireGraphNav(svg) {
  let panning = false;
  const apply = () => svg.setAttribute("viewBox", gVb.join(" "));
  svg.onmousedown = (ev) => {
    if (ev.target.closest(".gnode")) return;  // node clicks stay clicks
    panning = true;
    ev.preventDefault();
  };
  svg.onmousemove = (ev) => {
    if (!panning) return;
    const r = svg.getBoundingClientRect();
    gVb[0] -= (ev.movementX / r.width) * gVb[2];
    gVb[1] -= (ev.movementY / r.height) * gVb[3];
    apply();
  };
  svg.onmouseup = svg.onmouseleave = () => { panning = false; };
  svg.onwheel = (ev) => {
    ev.preventDefault();
    const r = svg.getBoundingClientRect();
    const mx = gVb[0] + ((ev.clientX - r.left) / r.width) * gVb[2];
    const my = gVb[1] + ((ev.clientY - r.top) / r.height) * gVb[3];
    const f = ev.deltaY > 0 ? 1.15 : 0.87;
    gVb = [mx - (mx - gVb[0]) * f, my - (my - gVb[1]) * f, gVb[2] * f, gVb[3] * f];
    apply();
  };
  svg.ondblclick = (ev) => {
    if (ev.target.closest(".gnode")) return;
    gVb = [0, 0, gNat[0], gNat[1]];
    apply();
  };
}

function setActiveNode(node) {
  if (activeNode === node) return;
  markActiveDone();
  activeNode = node;
  const g = document.getElementById("gn-" + cssId(node));
  if (g) g.classList.add("active");
  document.getElementById("gn-" + cssId("__start__"))?.classList.add("done");
}

function markActiveDone() {
  if (!activeNode) return;
  const g = document.getElementById("gn-" + cssId(activeNode));
  if (g) { g.classList.remove("active"); g.classList.add("done"); }
  activeNode = null;
}

/* ---------------- sweep ---------------- */

$("runall").onclick = async () => {
  if (!confirm("Run all architectures with their benchmark tasks through Codex? This makes a few hundred LLM calls and can take a while.")) return;
  const r = await fetch("/api/sweep", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: $("model").value, effort: $("effort").value }),
  });
  if (!r.ok) { const e = await r.json(); alert(e.error || "sweep failed to start"); return; }
  $("sweepbar").dataset.closed = "0";
  $("sweepbar").classList.add("on");
};

$("sweepcancel").onclick = async () => {
  await fetch("/api/sweep/cancel", { method: "POST" });
};

$("sweepmin").onclick = () => {
  const min = $("sweepbar").classList.toggle("min");
  $("sweepmin").innerHTML = min ? "&#9652;" : "&#9662;";
};

$("sweepclose").onclick = () => {
  $("sweepbar").dataset.closed = "1";
  $("sweepbar").classList.remove("on");
};

async function pollStatus() {
  try {
    const st = await (await fetch("/api/sweep/status")).json();
    // header stats
    $("s-calls").textContent = st.shim.calls;
    $("s-flight").textContent = st.shim.in_flight;
    $("s-avg").textContent = st.shim.calls ? (st.shim.total_seconds / st.shim.calls).toFixed(1) : "–";
    // per-card live status
    for (const [cls, run] of Object.entries(st.runs)) {
      if (run.status === "running") setDot(cls, "running", `running · ${run.seconds}s · ${run.llm_calls} calls`);
    }
    // sweep bar (collapsible via ▾, dismissible via ×; a new sweep re-opens it)
    const bar = $("sweepbar");
    const sweeping = st.sweep.active;
    if (sweeping && !window._sweepWasActive) bar.dataset.closed = "0";
    window._sweepWasActive = sweeping;
    bar.classList.toggle("on", (sweeping || bar.dataset.linger === "1") && bar.dataset.closed !== "1");
    if (sweeping) bar.dataset.linger = "1";
    if ($("sweepbar").classList.contains("on")) {
      const dots = $("sweepdots");
      if (!dots.childElementCount) {
        for (const cls of Object.keys(CATALOG)) {
          const d = document.createElement("div");
          d.className = "sdot"; d.id = "sdot-" + cls; d.dataset.name = cls;
          d.onclick = () => openDrawer(cls);
          dots.appendChild(d);
        }
      }
      let pass = 0, fail = 0, err = 0, running = 0;
      for (const cls of Object.keys(CATALOG)) {
        const run = st.runs[cls];
        const d = $("sdot-" + cls);
        if (!d) continue;
        d.className = "sdot" + (run ? " " + run.status : "");
        if (run) {
          if (run.status === "pass") pass++;
          else if (run.status === "fail") fail++;
          else if (run.status === "error") err++;
          else if (run.status === "running") running++;
        }
      }
      const el = st.elapsed ? ` · ${Math.floor(st.elapsed / 60)}m${String(Math.round(st.elapsed % 60)).padStart(2, "0")}s` : "";
      $("sweepsum").innerHTML = `<b>${pass} pass</b> · ${fail} fail · ${err} err · ${running} running${el}`;
    }
  } catch (e) { /* server briefly away */ }
  setTimeout(pollStatus, 1200);
}

/* ---------------- results refresh (post-sweep card states) ---------------- */

async function pollResults() {
  try {
    RESULTS = await (await fetch("/api/results")).json();
    refreshCards();
  } catch (e) { /* ignore */ }
  setTimeout(pollResults, 4000);
}

loadCatalog().then(() => { pollStatus(); pollResults(); });
