// DogYard run console. Vanilla JS, no build step; talks to src/ui/server.ts.
"use strict";

const TOKEN = new URLSearchParams(location.search).get("token") ?? "";
const SVG_NS = "http://www.w3.org/2000/svg";
const NODE_W = 184;
const NODE_H = 58;
const GAP_X = 44;
const GAP_Y = 74;
const MAX_LOG_CHARS = 2_000_000;
const STATUS_GLYPH = { running: "●", succeeded: "✓", failed: "✗", interrupted: "◌", paused: "⏸", caught: "◐", skipped: "–", pending: "○" };
const TYPE_ICON = { command: "›_", transform: "ƒ", pass: "→", choice: "◇", map: "⧉" };

const state = {
  flow: null,
  runs: [],
  runId: null,
  /** { trace, progress, control } of the selected run. */
  view: null,
  selected: null,
  /** Selected map item index in the inspector. */
  item: null,
  tab: "flow",
  lineagePinned: false,
  logText: "",
  logEnd: 0,
  logFilter: "all",
  layout: null,
  transform: { x: 0, y: 0, k: 1 },
  followGraph: true,
  events: null,
  /** Inspector section to open/scroll to after the next render. */
  focusSection: null,
  /** Which side/bottom panes are visible; remembered per browser. */
  panes: { runs: true, inspector: true, logs: true },
  /** Panes to bring back when leaving "focus graph". */
  panesBeforeFocus: null,
};

const PANES = ["runs", "inspector", "logs"];
const PANES_KEY = "dogyard.panes";
const TEXT_MAX_KEY = "dogyard.textMax";
const THEME_KEY = "dogyard.theme";

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const json = (v) => JSON.stringify(v, null, 2);

// ---------------------------------------------------------------- api

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers: { "x-dogyard-token": TOKEN, ...(opts.body ? { "content-type": "application/json" } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(message, kind = "info") {
  const el = document.createElement("div");
  el.className = `toast ${kind === "error" ? "err" : ""}`;
  el.textContent = message;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), kind === "error" ? 8000 : 3500);
}

async function copy(text, what = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what}: ${text.length > 80 ? `${text.slice(0, 80)}…` : text}`);
  } catch {
    showText("Copy", text);
  }
}

// ---------------------------------------------------------------- formatting

function fmtDuration(ms) {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function since(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function elapsed(start, end) {
  if (!start) return undefined;
  return (end ? Date.parse(end) : Date.now()) - Date.parse(start);
}

/** Display status of the selected run: `paused` overlays `running`. */
function runStatus() {
  const t = state.view?.trace;
  if (!t) return null;
  return t.status === "running" && t.paused_at ? "paused" : t.status;
}

function stepTrace(name) {
  return state.view?.trace.steps.find((s) => s.name === name);
}

function stepProgress(name) {
  return state.view?.progress.steps.find((s) => s.name === name);
}

function stepInfo(name) {
  return state.flow?.steps.find((s) => s.name === name);
}

/** Line-based YAML highlighter; block scalar (`|`/`>`) contents are left plain. */
function highlightYaml(text) {
  let blockIndent = -1; // indent of the line that opened a block scalar, or -1
  const value = (s) => {
    const c = s.indexOf(" #");
    const body = c >= 0 ? s.slice(0, c) : s;
    const com = c >= 0 ? `<span class="y-com">${esc(s.slice(c))}</span>` : "";
    const lit = /^(\s*)(true|false|null|~|-?\d+(?:\.\d+)?)(\s*)$/.exec(body);
    const blk = /^(\s*)([|>][-+]?)(\s*)$/.exec(body);
    if (lit) return `${lit[1]}<span class="y-lit">${lit[2]}</span>${lit[3]}${com}`;
    if (blk) return `${blk[1]}<span class="y-punct">${esc(blk[2])}</span>${blk[3]}${com}`;
    return `${esc(body).replace(/(&quot;.*?&quot;|&#39;.*?&#39;)/g, '<span class="y-str">$1</span>')}${com}`;
  };
  return text
    .split("\n")
    .map((line) => {
      const indent = /^\s*/.exec(line)[0].length;
      if (blockIndent >= 0 && (line.trim() === "" || indent > blockIndent)) return esc(line);
      blockIndent = -1;
      if (/^\s*#/.test(line)) return `<span class="y-com">${esc(line)}</span>`;
      const [, lead, dash = "", rest] = /^(\s*)(- )?(.*)$/.exec(line);
      const m = /^([\w-]+)(:)(.*)$/.exec(rest);
      if (/^\s*[|>][-+]?\s*(#.*)?$/.test(m ? m[3] : rest)) blockIndent = indent;
      const head = `${lead}${dash ? '<span class="y-punct">-</span> ' : ""}`;
      if (m) return `${head}<span class="y-key">${esc(m[1])}</span>${m[2]}${value(m[3])}`;
      return head + value(rest);
    })
    .join("\n");
}

// ---------------------------------------------------------------- graph layout

/** Layered top-to-bottom layout: layer = longest path from a root; order within a layer by parent barycenter. */
function computeLayout(flow) {
  const parents = new Map(flow.steps.map((s) => [s.name, []]));
  const children = new Map(flow.steps.map((s) => [s.name, []]));
  for (const e of flow.edges) {
    parents.get(e.to)?.push(e.from);
    children.get(e.from)?.push(e.to);
  }
  const order = flow.order.length === flow.steps.length ? flow.order : flow.steps.map((s) => s.name);
  const layer = new Map();
  for (const n of order) layer.set(n, Math.max(-1, ...parents.get(n).map((p) => layer.get(p) ?? -1)) + 1);
  const rows = [];
  for (const n of order) (rows[layer.get(n)] ??= []).push(n);
  const xIndex = new Map();
  rows.forEach((row, r) => {
    if (r > 0) {
      const bary = (n) => {
        const ps = parents.get(n).filter((p) => xIndex.has(p));
        return ps.length ? ps.reduce((a, p) => a + xIndex.get(p), 0) / ps.length : Infinity;
      };
      row.sort((a, b) => bary(a) - bary(b) || order.indexOf(a) - order.indexOf(b));
    }
    const offset = (row.length - 1) / 2;
    row.forEach((n, i) => xIndex.set(n, i - offset));
  });
  const pos = new Map();
  for (const [n, xi] of xIndex) pos.set(n, { x: xi * (NODE_W + GAP_X), y: layer.get(n) * (NODE_H + GAP_Y) });
  return { pos, rows, layer, parents, children };
}

function svg(tag, attrs = {}, children = []) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, v);
  for (const c of children) el.append(c);
  return el;
}

function edgePath(a, b) {
  const x1 = a.x;
  const y1 = a.y + NODE_H / 2;
  const x2 = b.x;
  const y2 = b.y - NODE_H / 2 - 2;
  const dy = Math.max(30, (y2 - y1) / 2);
  return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
}

function renderGraph() {
  const vp = $("#viewport");
  vp.replaceChildren();
  if (!state.flow) return;
  state.layout = computeLayout(state.flow);
  const { pos } = state.layout;
  const edges = svg("g", { class: "edges" });
  // Several branches (or a branch plus the default) to the same target share one drawn edge.
  const merged = new Map();
  for (const e of state.flow.edges) {
    const key = `${e.from}\u0000${e.to}`;
    const m = merged.get(key);
    if (m) m.labels.push(e.label);
    else merged.set(key, { ...e, labels: [e.label] });
  }
  for (const e of merged.values()) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const d = edgePath(a, b);
    const g = svg("g", { class: `edge ${e.kind}`, "data-from": e.from, "data-to": e.to }, [
      svg("path", { d, "marker-end": "url(#arrow)" }),
      svg("path", { d, class: "hit" }),
    ]);
    if (e.kind === "choice") {
      const short = (l) => (l === "default" ? "default" : l.replace(/^steps\.[\w-]+\.output\./, "").replace(/\s+/g, " "));
      const text = e.labels.map(short).join(" | ");
      // Near the target end, where sibling edges have already fanned apart.
      const t = svg("text", { x: a.x + (b.x - a.x) * 0.8, y: b.y - NODE_H / 2 - 14, "text-anchor": "middle" });
      t.textContent = text.length > 26 ? `${text.slice(0, 25)}…` : text;
      g.append(t);
    }
    const whens = e.labels.map((l) => (l === "default" ? "default (no branch matched)" : `when: ${l}`)).join("\n");
    g.addEventListener("mouseenter", (ev) => showTooltip(ev, `<b>${esc(e.from)} → ${esc(e.to)}</b><div class="muted">${e.kind === "choice" ? "choice branch" : "needs"}</div>${e.kind === "choice" ? `<pre class="code wrap">${esc(whens)}</pre>` : ""}`));
    g.addEventListener("mousemove", moveTooltip);
    g.addEventListener("mouseleave", hideTooltip);
    edges.append(g);
  }
  const nodes = svg("g", { class: "nodes" });
  for (const s of state.flow.steps) {
    const p = pos.get(s.name);
    const g = svg("g", { class: "node s-none", "data-name": s.name, transform: `translate(${p.x - NODE_W / 2}, ${p.y - NODE_H / 2})`, tabindex: "-1" });
    g.append(
      svg("rect", { class: "box", width: NODE_W, height: NODE_H, rx: 10 }),
      svg("rect", { class: "stripe", x: 0, y: 8, width: 4, height: NODE_H - 16, rx: 2 }),
    );
    const icon = svg("text", { class: "badge", x: 14, y: 22 });
    icon.textContent = TYPE_ICON[s.type] ?? "•";
    const name = svg("text", { class: "name", x: 34, y: 22 });
    name.textContent = s.name.length > 19 ? `${s.name.slice(0, 18)}…` : s.name;
    const meta = svg("text", { class: "meta", x: 14, y: 42 });
    meta.textContent = s.type;
    const flag = svg("text", { class: "badge", x: NODE_W - 12, y: 22, "text-anchor": "end" });
    flag.textContent = s.terminal === "success" ? "⚑" : s.terminal === "fail" ? "⚑!" : "";
    g.append(icon, name, meta, flag);
    if (s.type === "map") g.append(svg("rect", { class: "bar-bg", x: 14, y: NODE_H - 9, width: NODE_W - 28, height: 3, rx: 1.5 }), svg("rect", { class: "bar", x: 14, y: NODE_H - 9, width: 0, height: 3, rx: 1.5 }));
    g.addEventListener("mouseenter", (ev) => {
      showTooltip(ev, nodeTooltip(s.name));
      if (!state.lineagePinned) highlightLineage(s.name);
    });
    g.addEventListener("mousemove", moveTooltip);
    g.addEventListener("mouseleave", () => {
      hideTooltip();
      if (!state.lineagePinned) highlightLineage(null);
    });
    g.addEventListener("click", (ev) => {
      ev.stopPropagation();
      selectStep(s.name, { popover: true });
    });
    g.addEventListener("dblclick", (ev) => {
      ev.stopPropagation();
      selectStep(s.name, { section: "details" });
    });
    nodes.append(g);
  }
  vp.append(edges, nodes);
  updateGraphState();
  fitGraph();
}

function nodeTooltip(name) {
  const info = stepInfo(name);
  const st = stepTrace(name);
  const pr = stepProgress(name);
  const status = st ? st.status : "not run";
  const dur = st ? fmtDuration(st.status === "running" ? elapsed(st.started_at) : st.duration_ms ?? pr?.elapsed_ms) : "";
  const items = pr?.items ? ` · ${pr.items.done}/${pr.items.total} items` : "";
  const desc = info?.description ? `<div class="desc">${esc(info.description.split("\n")[0])}</div>` : "";
  return `<b>${esc(name)}</b> <span class="chip">${esc(info?.type)}</span><div class="muted">${esc(status)}${dur ? ` · ${dur}` : ""}${items}</div>${desc}<div class="muted small">click for actions · double-click for details</div>`;
}

/** Recolor nodes/edges from the selected run (or neutral when showing the definition). */
function updateGraphState() {
  const nodes = document.querySelectorAll("#viewport .node");
  for (const g of nodes) {
    const name = g.dataset.name;
    const st = stepTrace(name);
    const pr = stepProgress(name);
    const info = stepInfo(name);
    const status = st ? st.status : "none";
    g.setAttribute("class", `node s-${status}${state.selected === name ? " selected" : ""}`);
    const meta = g.querySelector(".meta");
    const parts = [info?.type ?? ""];
    if (st && st.status !== "pending") {
      const ms = st.status === "running" ? elapsed(st.started_at) : st.duration_ms ?? pr?.elapsed_ms;
      parts.push(st.status === "running" ? `running ${fmtDuration(ms)}` : `${st.status}${ms !== undefined ? ` ${fmtDuration(ms)}` : ""}`);
    } else if (st) parts.push("pending");
    if (pr?.items) parts.push(`${pr.items.done}/${pr.items.total}`);
    if (st?.cache?.hit) parts.push("cached");
    if (st?.attempts?.length > 1) parts.push(`×${st.attempts.length}`);
    meta.textContent = parts.join(" · ");
    const bar = g.querySelector(".bar");
    if (bar) bar.setAttribute("width", pr?.items?.total ? ((NODE_W - 28) * pr.items.done) / pr.items.total : 0);
  }
  for (const e of document.querySelectorAll("#viewport .edge")) {
    const from = stepTrace(e.dataset.from);
    const to = stepTrace(e.dataset.to);
    const taken = from && to && ["succeeded", "caught"].includes(from.status) && to.status !== "pending" && to.status !== "skipped" && (!e.classList.contains("choice") || from.selected === e.dataset.to);
    e.classList.toggle("taken", Boolean(taken));
  }
  $("#paused-banner").hidden = runStatus() !== "paused";
  if (state.followGraph) followRunning();
}

function lineageOf(name) {
  const { parents, children } = state.layout;
  const set = new Set([name]);
  const walk = (n, map) => {
    for (const m of map.get(n) ?? []) {
      if (set.has(m)) continue;
      set.add(m);
      walk(m, map);
    }
  };
  walk(name, parents);
  walk(name, children);
  return set;
}

function highlightLineage(name) {
  const set = name ? lineageOf(name) : null;
  for (const g of document.querySelectorAll("#viewport .node")) g.classList.toggle("dim", Boolean(set && !set.has(g.dataset.name)));
  for (const e of document.querySelectorAll("#viewport .edge")) e.classList.toggle("dim", Boolean(set && !(set.has(e.dataset.from) && set.has(e.dataset.to))));
}

// ---------------------------------------------------------------- pan / zoom

function applyTransform() {
  const { x, y, k } = state.transform;
  $("#viewport").setAttribute("transform", `translate(${x}, ${y}) scale(${k})`);
  positionPopover();
}

function graphBounds() {
  const xs = [...state.layout.pos.values()];
  if (!xs.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return {
    minX: Math.min(...xs.map((p) => p.x)) - NODE_W / 2,
    maxX: Math.max(...xs.map((p) => p.x)) + NODE_W / 2,
    minY: Math.min(...xs.map((p) => p.y)) - NODE_H / 2,
    maxY: Math.max(...xs.map((p) => p.y)) + NODE_H / 2,
  };
}

function fitGraph() {
  if (!state.layout) return;
  const box = $("#graph").getBoundingClientRect();
  const b = graphBounds();
  const pad = 48;
  const k = Math.min(1.25, (box.width - pad * 2) / Math.max(1, b.maxX - b.minX), (box.height - pad * 2 - 30) / Math.max(1, b.maxY - b.minY));
  state.transform = { k, x: box.width / 2 - ((b.minX + b.maxX) / 2) * k, y: (box.height - 30) / 2 - ((b.minY + b.maxY) / 2) * k };
  applyTransform();
}

function zoomAt(factor, cx, cy) {
  const t = state.transform;
  const k = Math.min(3, Math.max(0.2, t.k * factor));
  state.transform = { k, x: cx - ((cx - t.x) * k) / t.k, y: cy - ((cy - t.y) * k) / t.k };
  applyTransform();
}

function centerOn(names) {
  const pts = names.map((n) => state.layout.pos.get(n)).filter(Boolean);
  if (!pts.length) return;
  const box = $("#graph").getBoundingClientRect();
  const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  // Only move when the target is near the edge, so following doesn't jitter.
  const sx = state.transform.x + cx * state.transform.k;
  const sy = state.transform.y + cy * state.transform.k;
  const margin = 90;
  if (sx > margin && sx < box.width - margin && sy > margin && sy < box.height - margin) return;
  state.transform = { ...state.transform, x: box.width / 2 - cx * state.transform.k, y: box.height / 2 - cy * state.transform.k };
  applyTransform();
}

function followRunning() {
  const running = state.view?.trace.steps.filter((s) => s.status === "running").map((s) => s.name) ?? [];
  if (running.length && state.layout) centerOn(running);
}

function setFollow(on) {
  state.followGraph = on;
  $("#follow-graph").checked = on;
}

function initPanZoom() {
  const el = $("#graph");
  let drag = null;
  el.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0 || ev.target.closest(".node")) return;
    drag = { x: ev.clientX, y: ev.clientY, tx: state.transform.x, ty: state.transform.y, moved: false };
    el.classList.add("panning");
  });
  window.addEventListener("mousemove", (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) {
      drag.moved = true;
      setFollow(false);
    }
    state.transform = { ...state.transform, x: drag.tx + dx, y: drag.ty + dy };
    applyTransform();
  });
  window.addEventListener("mouseup", () => {
    if (!drag) return;
    el.classList.remove("panning");
    // A click (no drag) on the background selects the flow.
    if (!drag.moved) {
      closePopover();
      selectFlow();
    }
    drag = null;
  });
  el.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      const r = el.getBoundingClientRect();
      // Trackpad pinch arrives as ctrl+wheel with small deltas.
      const factor = Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015));
      zoomAt(factor, ev.clientX - r.left, ev.clientY - r.top);
      setFollow(false);
    },
    { passive: false },
  );
  const zoomCenter = (f) => {
    const r = el.getBoundingClientRect();
    zoomAt(f, r.width / 2, r.height / 2);
  };
  $("#zoom-in").onclick = () => zoomCenter(1.2);
  $("#zoom-out").onclick = () => zoomCenter(1 / 1.2);
  $("#zoom-fit").onclick = fitGraph;
  $("#follow-graph").onchange = (ev) => {
    state.followGraph = ev.target.checked;
    if (state.followGraph) followRunning();
  };
  window.addEventListener("resize", () => positionPopover());
}

// ---------------------------------------------------------------- tooltip / popover

function showTooltip(ev, html) {
  const t = $("#tooltip");
  t.innerHTML = html;
  t.hidden = false;
  moveTooltip(ev);
}

function moveTooltip(ev) {
  const t = $("#tooltip");
  const r = $("#graph-pane").getBoundingClientRect();
  let x = ev.clientX - r.left + 14;
  let y = ev.clientY - r.top + 14;
  if (x + t.offsetWidth > r.width - 8) x = ev.clientX - r.left - t.offsetWidth - 14;
  if (y + t.offsetHeight > r.height - 8) y = ev.clientY - r.top - t.offsetHeight - 14;
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
}

function hideTooltip() {
  $("#tooltip").hidden = true;
}

function openPopover(name) {
  hideTooltip();
  const info = stepInfo(name);
  const st = stepTrace(name);
  const hasRun = Boolean(st);
  const logsAvailable = hasRun && (state.view.control.has_log || st.stderr || st.items?.some((i) => i.stderr));
  const flowArg = state.flow.display_dir;
  const items = [
    ["details", "ⓘ", "Details", true],
    ["logs", "≡", "Logs", logsAvailable],
    ["io", "⇄", "Input / Output", hasRun && (st.input !== undefined || st.output !== undefined)],
    ["attempts", "↻", "Attempts & errors", hasRun && (st.attempts.length > 0 || Boolean(st.error))],
    ...(info.type === "map" ? [["items", "⧉", "Map items", Boolean(st?.items?.length)]] : []),
    ["lineage", "⑂", state.lineagePinned && state.selected === name ? "Unpin lineage" : "Focus lineage", true],
  ];
  const copies = [
    ["copy-name", "Step name", name],
    ["copy-ref", "Output reference", `steps.${name}.output`],
    ...(info.has_tests ? [["copy-test", "Test command", `dogyard test ${flowArg} --step ${name}`]] : []),
    ...(info.has_evals ? [["copy-eval", "Eval command", `dogyard eval ${flowArg} --step ${name}`]] : []),
  ];
  const p = $("#popover");
  p.innerHTML = `
    <div class="pop-head"><b>${esc(name)}</b> <span class="chip">${esc(info.type)}</span>${st ? ` <span class="chip status s-${esc(st.status)}">${esc(st.status)}</span>` : ""}
      ${info.description ? `<div class="muted">${esc(info.description.split("\n")[0])}</div>` : ""}</div>
    ${items.map(([id, k, label, ok]) => `<button data-act="${id}" ${ok ? "" : "disabled"}><span class="k">${k}</span>${esc(label)}</button>`).join("")}
    <hr><div class="pop-label">Copy</div>
    ${copies.map(([id, label]) => `<button data-act="${id}"><span class="k">⎘</span>${esc(label)}</button>`).join("")}`;
  p.dataset.name = name;
  p.hidden = false;
  p.onclick = (ev) => {
    const btn = ev.target.closest("button[data-act]");
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    const c = copies.find(([id]) => id === act);
    closePopover();
    if (c) return copy(c[2]);
    if (act === "logs") return filterLogs(name);
    if (act === "lineage") {
      state.lineagePinned = !(state.lineagePinned && state.selected === name);
      highlightLineage(state.lineagePinned ? name : null);
      return;
    }
    selectStep(name, { section: act });
  };
  positionPopover();
  p.querySelector("button:not(:disabled)")?.focus();
}

function positionPopover() {
  const p = $("#popover");
  if (p.hidden || !state.layout) return;
  const pos = state.layout.pos.get(p.dataset.name);
  if (!pos) return;
  const { x, y, k } = state.transform;
  const pane = $("#graph-pane").getBoundingClientRect();
  let left = x + (pos.x + NODE_W / 2) * k + 10;
  let top = y + (pos.y - NODE_H / 2) * k;
  if (left + p.offsetWidth > pane.width - 8) left = x + (pos.x - NODE_W / 2) * k - p.offsetWidth - 10;
  top = Math.max(8, Math.min(top, pane.height - p.offsetHeight - 8));
  p.style.left = `${Math.max(8, left)}px`;
  p.style.top = `${top}px`;
}

function closePopover() {
  $("#popover").hidden = true;
}

// ---------------------------------------------------------------- selection

function selectStep(name, opts = {}) {
  state.selected = name;
  if (state.item !== null && stepInfo(name)?.type !== "map") state.item = null;
  state.tab = "step";
  if (opts.section) {
    state.focusSection = opts.section;
    setPane("inspector", true);
  }
  updateGraphState();
  renderInspector();
  if (opts.popover) openPopover(name);
  else closePopover();
  document.querySelector(`#viewport .node[data-name="${CSS.escape(name)}"]`)?.focus({ preventScroll: true });
}

function selectFlow() {
  state.selected = null;
  state.item = null;
  state.tab = "flow";
  if (state.lineagePinned) {
    state.lineagePinned = false;
    highlightLineage(null);
  }
  updateGraphState();
  renderInspector();
}

function initKeyboard() {
  document.addEventListener("keydown", (ev) => {
    if (ev.target.closest("input, textarea, dialog")) return;
    if (ev.key === "Escape") {
      if (!$("#popover").hidden) return closePopover();
      return selectFlow();
    }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const paneKeys = { "[": "runs", "]": "inspector", "\\": "logs" };
    if (paneKeys[ev.key]) return togglePane(paneKeys[ev.key]);
    if (ev.key === "g") return toggleFocusGraph();
    if (ev.key === "f") return fitGraph();
    if (!state.layout) return;
    if (ev.key === "Enter" && state.selected && !ev.target.closest("#popover")) {
      ev.preventDefault();
      return openPopover(state.selected);
    }
    const arrows = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    if (!arrows.includes(ev.key) || ev.target.closest("#popover, #inspector, #logs")) return;
    ev.preventDefault();
    const { parents, children, rows, layer } = state.layout;
    if (!state.selected) return selectStep(rows[0][0]);
    const cur = state.selected;
    const row = rows[layer.get(cur)];
    const i = row.indexOf(cur);
    let next;
    if (ev.key === "ArrowDown") next = children.get(cur)[0];
    if (ev.key === "ArrowUp") next = parents.get(cur)[0];
    if (ev.key === "ArrowLeft") next = row[i - 1];
    if (ev.key === "ArrowRight") next = row[i + 1];
    if (next) {
      selectStep(next);
      centerOn([next]);
    }
  });
}

// ---------------------------------------------------------------- inspector

function renderInspector() {
  for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t.dataset.tab === state.tab);
  document.querySelector('.tab[data-tab="step"]').disabled = !state.selected;
  const body = $("#inspector-body");
  // Keep the user's open/closed choices across live re-renders.
  const open = new Set([...body.querySelectorAll("details.section[open]")].map((d) => d.dataset.id));
  const closed = new Set([...body.querySelectorAll("details.section:not([open])")].map((d) => d.dataset.id));
  const scroll = $("#inspector").scrollTop;
  body.innerHTML = state.tab === "step" && state.selected ? stepHtml(state.selected) : flowHtml();
  for (const d of body.querySelectorAll("details.section")) {
    if (open.has(d.dataset.id)) d.open = true;
    if (closed.has(d.dataset.id)) d.open = false;
  }
  $("#inspector").scrollTop = scroll;
  if (state.focusSection) {
    const d = body.querySelector(`details.section[data-id="${state.focusSection}"]`);
    state.focusSection = null;
    if (d) {
      d.open = true;
      d.scrollIntoView({ block: "start", behavior: "smooth" });
      d.classList.add("flash");
    }
  }
}

function section(id, title, inner, { open = true, extra = "" } = {}) {
  return `<details class="section" data-id="${id}" ${open ? "open" : ""}><summary><h3>${esc(title)}</h3>${extra}</summary>${inner}</details>`;
}

function kv(rows) {
  const r = rows.filter(([, v]) => v !== undefined && v !== null && v !== "");
  return r.length ? `<dl class="kv">${r.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>` : "";
}

const code = (v, wrap = false) => `<pre class="code${wrap ? " wrap" : ""}">${esc(typeof v === "string" ? v : json(v))}</pre>`;
const mono = (v) => `<code>${esc(typeof v === "string" ? v : JSON.stringify(v))}</code>`;

function flowHtml() {
  const f = state.flow;
  if (!f) return `<p class="empty-note">Loading…</p>`;
  const counts = {};
  for (const s of f.steps) counts[s.type] = (counts[s.type] ?? 0) + 1;
  const terminals = f.steps.filter((s) => s.terminal);
  const last = state.runs[0];
  const schema = f.trigger_schema;
  const props = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const constraint = (p) =>
    Object.entries(p)
      .filter(([k]) => !["type", "description"].includes(k))
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(", ");
  const triggerTable = Object.keys(props).length
    ? `<table class="grid"><tr><th>field</th><th>type</th><th>constraints</th></tr>${Object.entries(props)
        .map(([k, p]) => `<tr><td>${mono(k)}${required.has(k) ? ' <span class="chip">required</span>' : ""}${p.description ? `<div class="muted small">${esc(p.description)}</div>` : ""}</td><td>${esc(p.type ?? "any")}</td><td class="muted">${esc(constraint(p))}</td></tr>`)
        .join("")}</table>`
    : schema
      ? code(schema)
      : `<p class="empty-note">No trigger_schema: any JSON object is accepted.</p>`;
  const config = Object.entries(f.config)
    .map(([k, { value, source }]) => `<tr><td>${mono(k)}</td><td>${mono(value)}</td><td><span class="chip src-${source}" title="${source === "project" ? esc(f.project_file) : ""}">${source === "project" ? "workflows.yaml" : source}</span></td></tr>`)
    .join("");
  return `
    <h2>${esc(f.name)} <span class="chip">v${esc(f.version)}</span></h2>
    ${f.description ? `<p class="desc">${esc(f.description)}</p>` : ""}
    <div class="btn-row">
      <button class="btn small primary" data-do="start">▶ Start run…</button>
      <button class="btn small" data-do="source">View flow.yaml</button>
      <button class="btn small" data-do="export">Export graph</button>
    </div>
    ${section("overview", "Overview", kv([
      ["folder", `<span title="${esc(f.dir)}">${mono(f.display_dir)}</span>`],
      ["steps", `${f.steps.length} (${Object.entries(counts).map(([t, n]) => `${n} ${t}`).join(", ")})`],
      ["terminal", terminals.map((s) => `${mono(s.name)} <span class="muted">${s.terminal}</span>`).join(", ") || '<span class="muted">none</span>'],
      ["sinks", f.sinks.map(mono).join(", ")],
      ["tests", f.has_tests ? `<span class="chip">tests/</span> ${mono(`dogyard test ${f.display_dir}`)}` : '<span class="muted">none</span>'],
      ["evals", f.has_evals ? `<span class="chip">evals/</span> ${mono(`dogyard eval ${f.display_dir}`)}` : '<span class="muted">none</span>'],
      ["last run", last ? `${STATUS_GLYPH[last.paused ? "paused" : last.status] ?? ""} ${esc(last.paused ? "paused" : last.status)} · ${fmtDuration(last.duration_ms)} · ${since(last.started_at)}` : '<span class="muted">never</span>'],
    ]))}
    ${section("trigger", "Trigger", triggerTable)}
    ${section("config", "Config", config ? `<table class="grid"><tr><th>key</th><th>value</th><th>from</th></tr>${config}</table>` : "")}
    ${state.view ? section("run", "Selected run", runSummaryHtml()) : ""}`;
}

function runSummaryHtml() {
  const t = state.view.trace;
  return (
    kv([
      ["run", mono(t.run_id)],
      ["status", `<span class="chip status s-${runStatus()}">${esc(runStatus())}</span>`],
      ["started", esc(new Date(t.started_at).toLocaleString())],
      ["duration", fmtDuration(t.duration_ms ?? elapsed(t.started_at))],
      ["resumes", t.resume_count || undefined],
      ["terminal", t.terminal_step ? mono(t.terminal_step) : undefined],
      ["error", t.error ? `<span class="error">${esc(t.error.type)}: ${esc(t.error.message)}</span>` : undefined],
    ]) +
    section("trigger-value", "Trigger value", code(t.trigger), { open: false }) +
    (t.output !== undefined ? section("run-output", "Output", code(t.output)) : "")
  );
}

function stepHtml(name) {
  const info = stepInfo(name);
  if (!info) return `<p class="empty-note">Step ${esc(name)} is not in the flow definition.</p>`;
  const d = info.definition;
  const st = stepTrace(name);
  const pr = stepProgress(name);
  const sub = d.type === "map" ? d.step : null;
  const cmdDef = d.type === "command" ? d : sub?.type === "command" ? sub : null;
  const status = st ? `<span class="chip status s-${esc(st.status)}">${esc(st.status)}</span>` : "";

  const defRows = [
    ["needs", info.needs.length ? info.needs.map(mono).join(", ") : '<span class="muted">none (root)</span>'],
    ["terminal", d.terminal],
    ["command", cmdDef ? mono(cmdDef.command.join(" ")) : undefined],
    ["cwd", info.cwd ? mono(info.cwd) : undefined],
    ["input", (sub ?? d).input !== undefined ? code((sub ?? d).input, true) : undefined],
    ["input mode", cmdDef?.input_mode],
    ["output mode", cmdDef?.output_mode],
    ["env", cmdDef?.env ? Object.keys(cmdDef.env).map(mono).join(", ") : undefined],
    ["over", d.type === "map" ? code(d.over, true) : undefined],
    ["sub-step", sub ? `<span class="chip">${esc(sub.type)}</span>` : undefined],
    ["concurrency", d.max_concurrency],
    ["timeout", (sub ?? d).timeout ?? d.timeout],
    ["retry", (sub ?? d).retry ? mono((sub ?? d).retry) : undefined],
    ["catch", (sub ?? d).catch ? (sub ?? d).catch.map((c) => `${mono(c.error_type)} → ${mono(c.result ?? null)}`).join("<br>") : undefined],
    ["cache", (cmdDef?.cache ?? d.cache) ? mono(cmdDef?.cache ?? d.cache) : undefined],
  ];
  const branches =
    d.type === "choice"
      ? `<table class="grid"><tr><th>when</th><th>next</th></tr>${d.branches.map((b) => `<tr><td>${mono(b.when)}</td><td>${mono(b.next)}${st?.selected === b.next ? " ✓" : ""}</td></tr>`).join("")}${d.default ? `<tr><td class="muted">default</td><td>${mono(d.default)}${st?.selected === d.default ? " ✓" : ""}</td></tr>` : ""}</table>`
      : "";
  const details =
    kv(defRows) +
    branches +
    `<div class="btn-row">${info.yaml ? `<button class="btn small" data-do="yaml" data-step="${esc(name)}">Full YAML</button>` : ""}<button class="btn small" data-do="copy" data-text="${esc(`steps.${name}.output`)}">⎘ steps.${esc(name)}.output</button>${info.has_tests ? `<button class="btn small" data-do="copy" data-text="${esc(`dogyard test ${state.flow.display_dir} --step ${name}`)}">⎘ test cmd</button>` : ""}${info.has_evals ? `<button class="btn small" data-do="copy" data-text="${esc(`dogyard eval ${state.flow.display_dir} --step ${name}`)}">⎘ eval cmd</button>` : ""}</div>` +
    (info.yaml ? `<pre class="code">${highlightYaml(info.yaml)}</pre>` : "");

  let runPart = "";
  if (!st) {
    runPart = section("io", "Run state", `<p class="empty-note">${state.view ? "This run has no state for the step." : "Select a run to see its input, output and attempts."}</p>`);
  } else {
    const ms = st.status === "running" ? elapsed(st.started_at) : st.duration_ms ?? pr?.elapsed_ms;
    runPart += section(
      "state",
      "Run state",
      kv([
        ["status", status],
        ["duration", ms !== undefined ? fmtDuration(ms) : undefined],
        ["eta", pr?.eta_ms !== undefined ? `${pr.eta_source === "history" ? "~" : ""}${fmtDuration(pr.eta_ms)}` : undefined],
        ["items", pr?.items ? `${pr.items.done}/${pr.items.total}${pr.items.failed ? ` · ${pr.items.failed} failed` : ""}${pr.items.caught ? ` · ${pr.items.caught} caught` : ""}${pr.items.cached ? ` · ${pr.items.cached} cached` : ""}` : undefined],
        ["selected", st.selected ? mono(st.selected) : undefined],
        ["cache", st.cache ? (st.cache.hit ? `hit from ${mono(st.cache.source_run_id ?? "?")}` : "miss (stored)") : undefined],
        ["skipped", st.skip_reason ? esc(st.skip_reason) : undefined],
        ["argv", st.argv ? mono(st.argv.join(" ")) : undefined],
        ["exit code", st.exit_code],
      ]) + `<div class="btn-row"><button class="btn small" data-do="logs" data-step="${esc(name)}">≡ Logs for ${esc(name)}</button></div>`,
    );
    runPart += section("io", "Input / Output", st.input === undefined && st.output === undefined ? '<p class="empty-note">Not resolved yet.</p>' : `${st.input !== undefined ? `<h3>input</h3>${code(st.input)}` : ""}${st.output !== undefined ? `<h3>output</h3>${code(st.output)}` : ""}`);
    const attempts = st.attempts
      .map((a, i) => `<div class="attempt"><span class="chip">#${i + 1}</span><span class="muted">${esc(new Date(a.started_at).toLocaleTimeString())}</span>${a.ended_at ? `<span>${fmtDuration(elapsed(a.started_at, a.ended_at))}</span>` : "<span>running…</span>"}${a.error ? `<span class="error">${esc(a.error.type)}: ${esc(a.error.message)}</span>` : ""}</div>`)
      .join("");
    runPart += section(
      "attempts",
      "Attempts & errors",
      (attempts || '<p class="empty-note">No attempts recorded (non-command step or not started).</p>') +
        (st.error ? `<h3>error</h3>${code(`${st.error.type}: ${st.error.message}`, true)}` : "") +
        (st.stderr ? `<h3>stderr (tail)</h3>${code(st.stderr, true)}` : ""),
      { open: Boolean(st.error) },
    );
    if (st.items?.length) {
      const sel = state.item !== null ? st.items[state.item] : null;
      const grid = st.items.map((it) => `<button class="s-${esc(it.status)}${state.item === it.index ? " sel" : ""}" data-do="item" data-index="${it.index}" title="#${it.index} ${esc(it.status)}"></button>`).join("");
      const itemDetail = sel
        ? `<h3>item #${sel.index} <span class="chip status s-${esc(sel.status)}">${esc(sel.status)}</span></h3>` +
          kv([
            ["duration", sel.started_at && sel.ended_at ? fmtDuration(elapsed(sel.started_at, sel.ended_at)) : sel.started_at ? `running ${fmtDuration(elapsed(sel.started_at))}` : undefined],
            ["attempts", sel.attempts.length || undefined],
            ["exit code", sel.exit_code],
            ["cache", sel.cache ? (sel.cache.hit ? "hit" : "miss") : undefined],
            ["error", sel.error ? `<span class="error">${esc(sel.error.type)}: ${esc(sel.error.message)}</span>` : undefined],
          ]) +
          `<div class="btn-row"><button class="btn small" data-do="logs" data-step="${esc(`${name}[${sel.index}]`)}">≡ Logs for item #${sel.index}</button></div>` +
          (sel.input !== undefined ? `<h3>input</h3>${code(sel.input)}` : "") +
          (sel.output !== undefined ? `<h3>output</h3>${code(sel.output)}` : "") +
          (sel.stderr ? `<h3>stderr</h3>${code(sel.stderr, true)}` : "")
        : '<p class="empty-note">Click an item to inspect it.</p>';
      runPart += section("items", `Map items (${st.items.length})`, `<div class="items-grid">${grid}</div>${itemDetail}`);
    }
  }

  return `
    <h2><span class="muted">${TYPE_ICON[info.type] ?? ""}</span> ${esc(name)} <span class="chip">${esc(info.type)}</span> ${status}</h2>
    ${info.description ? `<p class="desc">${esc(info.description)}</p>` : '<p class="desc muted">No description.</p>'}
    ${section("details", "Definition", details, { open: !st })}
    ${runPart}`;
}

function initInspector() {
  for (const t of document.querySelectorAll(".tab")) {
    t.onclick = () => {
      if (t.dataset.tab === "flow") selectFlow();
      else if (state.selected) {
        state.tab = "step";
        renderInspector();
      }
    };
  }
  $("#inspector-body").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-do]");
    if (!b) return;
    const act = b.dataset.do;
    if (act === "start") openStartDialog();
    if (act === "source") viewSource();
    if (act === "export") viewExport("mermaid");
    if (act === "copy") copy(b.dataset.text);
    if (act === "logs") filterLogs(b.dataset.step);
    if (act === "yaml") showText(`${b.dataset.step} · flow.yaml`, stepInfo(b.dataset.step).yaml, "", "yaml");
    if (act === "item") {
      state.item = Number(b.dataset.index);
      renderInspector();
    }
  });
  $("#flow-title").onclick = () => {
    closePopover();
    selectFlow();
    setPane("inspector", true);
  };
}

// ---------------------------------------------------------------- text dialog

function showText(title, text, extraHtml = "", lang) {
  $("#text-title").textContent = title;
  $("#text-extra").innerHTML = extraHtml;
  if (lang === "yaml") $("#text-body").innerHTML = highlightYaml(text);
  else $("#text-body").textContent = text;
  const d = $("#text-dialog");
  if (!d.open) d.showModal();
}

async function viewSource() {
  try {
    const { text } = await api("/api/flow/source");
    showText(state.flow.file, text, "", "yaml");
  } catch (err) {
    toast(err.message, "error");
  }
}

async function viewExport(format) {
  try {
    const { text } = await api(`/api/flow/export?format=${format}`);
    const opts = ["mermaid", "dot", "json"].map((f) => `<option ${f === format ? "selected" : ""}>${f}</option>`).join("");
    showText("Export graph", text, `<select id="export-format">${opts}</select>`);
    $("#export-format").onchange = (ev) => viewExport(ev.target.value);
  } catch (err) {
    toast(err.message, "error");
  }
}

function initTextDialog() {
  $("#text-close").onclick = () => $("#text-dialog").close();
  $("#text-copy").onclick = () => copy($("#text-body").textContent);
  const setMax = (on) => {
    $("#text-dialog").classList.toggle("maximized", on);
    const b = $("#text-max");
    b.setAttribute("aria-pressed", String(on));
    b.textContent = on ? "⤡" : "⤢";
    b.title = on ? "Restore size" : "Maximize";
  };
  try {
    setMax(localStorage.getItem(TEXT_MAX_KEY) === "1");
  } catch {
    setMax(false);
  }
  $("#text-max").onclick = () => {
    const on = !$("#text-dialog").classList.contains("maximized");
    setMax(on);
    try {
      localStorage.setItem(TEXT_MAX_KEY, on ? "1" : "0");
    } catch {}
  };
}

// ---------------------------------------------------------------- logs

function initLogs() {
  $("#log-follow").onchange = () => {
    if ($("#log-follow").checked) scrollLogs();
  };
  $("#log-body").addEventListener("scroll", () => {
    const el = $("#log-body");
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    $("#log-follow").checked = atBottom;
  });
  let resize = null;
  $("#logs-resize").addEventListener("mousedown", (ev) => {
    resize = { y: ev.clientY, h: $("#logs").getBoundingClientRect().height };
    ev.preventDefault();
  });
  window.addEventListener("mousemove", (ev) => {
    if (!resize) return;
    const h = Math.max(80, Math.min(window.innerHeight * 0.75, resize.h + resize.y - ev.clientY));
    document.documentElement.style.setProperty("--logs-h", `${h}px`);
  });
  window.addEventListener("mouseup", () => {
    if (resize) {
      resize = null;
      positionPopover();
    }
  });
  $("#log-filters").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-filter]");
    if (b) filterLogs(b.dataset.filter);
  });
}

function filterLogs(filter) {
  state.logFilter = filter;
  setPane("logs", true);
  $("#log-follow").checked = true;
  renderLogs();
}

function renderLogFilters() {
  const names = state.flow ? state.flow.steps.filter((s) => s.type === "command" || s.type === "map").map((s) => s.name) : [];
  const filters = ["all", ...names];
  if (!filters.includes(state.logFilter)) filters.push(state.logFilter);
  $("#log-filters").innerHTML = filters.map((f) => `<button data-filter="${esc(f)}" class="${f === state.logFilter ? "active" : ""}">${esc(f)}</button>`).join("");
}

/** Does a run.log line belong to `filter` (a step, or `step[i]` for one map item)? */
function lineMatches(line, filter) {
  if (filter === "all") return true;
  const item = /^(.*)\[(\d+)\]$/.exec(filter);
  if (item) return line.startsWith(`[${filter}] `);
  if (line.startsWith(`[${filter}] `) || line.startsWith(`[${filter}[`)) return true;
  // Step transition lines from the run's progress output: `[running    ] name (…)`.
  const m = /^\[[a-z]+ *\] ([^\s(]+)/.exec(line);
  return Boolean(m && m[1] === filter);
}

/** Lines to show when there is no run.log (a foreground run): transitions and captured stderr from the trace. */
function syntheticLog() {
  const t = state.view.trace;
  const lines = [];
  for (const s of t.steps) {
    if (s.started_at) lines.push([s.started_at, `[running    ] ${s.name}`]);
    for (const l of (s.stderr ?? "").split("\n").filter(Boolean)) lines.push([s.ended_at ?? s.started_at, `[${s.name}] ${l}`]);
    for (const it of s.items ?? []) for (const l of (it.stderr ?? "").split("\n").filter(Boolean)) lines.push([it.ended_at ?? it.started_at ?? s.started_at, `[${s.name}[${it.index}]] ${l}`]);
    if (s.ended_at && s.status !== "pending") lines.push([s.ended_at, `[${s.status.padEnd(11)}] ${s.name}${s.error ? ` (${s.error.type}: ${s.error.message})` : ""}`]);
  }
  return lines
    .filter(([at]) => at)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, l]) => l)
    .join("\n");
}

function renderLogs() {
  renderLogFilters();
  const body = $("#log-body");
  const note = $("#log-note");
  if (!state.view) {
    note.hidden = false;
    note.textContent = "Select or start a run to see its log.";
    body.textContent = "";
    return;
  }
  const hasLog = state.view.control.has_log;
  note.hidden = hasLog;
  if (!hasLog) note.textContent = "This run was not started with --detach or from the UI, so there is no run.log; showing the stderr captured in its trace.";
  const text = hasLog ? state.logText : syntheticLog();
  const lines = text.split("\n").filter((l) => lineMatches(l, state.logFilter));
  body.innerHTML = lines
    .map((l) => {
      if (l.startsWith("=== ")) return `<span class="l-head">${esc(l)}</span>`;
      const m = /^\[([a-z]+) *\] (.*)$/.exec(l);
      if (m && STATUS_GLYPH[m[1]]) return `<span class="l-t">[${esc(m[1].padEnd(11))}]</span> ${esc(m[2])}`;
      const s = /^(\[[^\]]+\]\]?) (.*)$/.exec(l);
      if (s) return `<span class="l-step">${esc(s[1])}</span> ${esc(s[2])}`;
      if (/error|failed|Received/i.test(l)) return `<span class="l-err">${esc(l)}</span>`;
      return esc(l);
    })
    .join("\n");
  scrollLogs();
}

function scrollLogs() {
  if ($("#log-follow").checked) $("#log-body").scrollTop = $("#log-body").scrollHeight;
}

// ---------------------------------------------------------------- runs

async function refreshRuns() {
  try {
    state.runs = await api("/api/runs");
  } catch (err) {
    return toast(err.message, "error");
  }
  state.runs.sort((a, b) => b.started_at.localeCompare(a.started_at));
  const latest = JSON.stringify(state.runs[0] ?? null);
  renderRunList();
  // The Flow tab shows the last run; refresh it when that changes.
  if (state.tab === "flow" && latest !== state.lastRunKey) renderInspector();
  state.lastRunKey = latest;
}

function renderRunList() {
  const ul = $("#run-list");
  if (!state.runs.length) {
    ul.innerHTML = '<li class="empty">No runs yet. Press ▶ Start.</li>';
    return;
  }
  ul.innerHTML = state.runs
    .map((r) => {
      const st = r.paused ? "paused" : r.status === "running" && !r.alive ? "interrupted" : r.status;
      const label = r.status === "running" && !r.alive ? "running (process gone)" : st;
      const idShort = r.run_id.replace(/^(\d{8})T(\d{6})Z-/, (_, d, t) => `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4)} `);
      return `<li data-run="${esc(r.run_id)}" class="${r.run_id === state.runId ? "selected" : ""}" title="${esc(r.run_id)}">
        <span class="glyph" style="color: var(--s-${st === "paused" ? "interrupted" : st})">${STATUS_GLYPH[st] ?? "•"}</span>
        <span class="rid">${esc(idShort)}</span>
        <span class="dur">${fmtDuration(r.duration_ms)}</span>
        <span class="sub">${esc(label)} · ${since(r.started_at)}${r.items_total ? ` · ${r.items_done}/${r.items_total}` : ""}${r.resume_count ? ` · resumed ×${r.resume_count}` : ""}</span>
      </li>`;
    })
    .join("");
}

function selectRun(runId) {
  if (state.events) state.events.close();
  state.events = null;
  state.runId = runId;
  state.view = null;
  state.logText = "";
  state.logEnd = 0;
  state.item = null;
  renderRunList();
  if (!runId) {
    renderAll();
    return;
  }
  const es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events?token=${encodeURIComponent(TOKEN)}`);
  state.events = es;
  es.addEventListener("trace", (ev) => {
    if (state.runId !== runId) return;
    const prev = state.view?.trace;
    state.view = JSON.parse(ev.data);
    if (!prev || prev.status !== state.view.trace.status || Boolean(prev.paused_at) !== Boolean(state.view.trace.paused_at)) void refreshRuns();
    renderAll();
  });
  es.addEventListener("control", (ev) => {
    if (state.runId !== runId || !state.view) return;
    state.view.control = JSON.parse(ev.data);
    renderToolbar();
    void refreshRuns();
  });
  es.addEventListener("log", (ev) => {
    if (state.runId !== runId) return;
    const { text, offset } = JSON.parse(ev.data);
    if (offset < state.logEnd || (offset > 0 && state.logEnd === 0)) state.logText = offset > 0 ? "…(earlier output truncated)\n" : "";
    state.logText += text;
    state.logEnd = offset + new TextEncoder().encode(text).length;
    if (state.logText.length > MAX_LOG_CHARS) state.logText = state.logText.slice(-MAX_LOG_CHARS);
    if (state.view) {
      state.view.control.has_log = true;
      renderLogs();
    }
  });
}

function initRunList() {
  $("#run-list").addEventListener("click", (ev) => {
    const li = ev.target.closest("li[data-run]");
    if (li) selectRun(li.dataset.run);
  });
  $("#btn-definition").onclick = () => selectRun(null);
}

// ---------------------------------------------------------------- toolbar / controls

function renderToolbar() {
  const pill = $("#run-pill");
  const t = state.view?.trace;
  const c = state.view?.control;
  if (!t) {
    pill.hidden = true;
    $("#run-id").textContent = state.runId ? "loading…" : "definition";
    $("#run-eta").textContent = "";
  } else {
    const st = runStatus();
    const gone = t.status === "running" && !c.alive;
    pill.hidden = false;
    pill.className = `pill s-${st}`;
    pill.textContent = `${STATUS_GLYPH[st] ?? ""} ${gone ? "running · process gone" : st}`;
    $("#run-id").textContent = t.run_id;
    const ms = t.duration_ms ?? elapsed(t.started_at);
    const etas = state.view.progress.steps.filter((s) => s.eta_ms !== undefined).map((s) => s.eta_ms);
    $("#run-eta").textContent = `${fmtDuration(ms)}${t.status === "running" && etas.length ? ` · ETA ${fmtDuration(Math.max(...etas))}` : ""}`;
  }
  const running = t?.status === "running" && c?.alive;
  const paused = running && (Boolean(t.paused_at) || c.pause_requested);
  const resumable = t && (t.status === "interrupted" || t.status === "failed" || (t.status === "running" && !c.alive));
  const pause = $("#btn-pause");
  pause.disabled = !running || paused;
  const resume = $("#btn-resume");
  resume.disabled = !(paused || resumable);
  resume.title = paused ? "Continue the paused run" : resumable ? "Resume from the checkpoint; completed steps are not re-run" : "Nothing to resume";
  const stop = $("#btn-stop");
  stop.disabled = !(running && c.detached);
  stop.title = running && !c.detached ? "Only runs started with --detach or from this UI can be stopped here (use Ctrl-C in its terminal)" : "Interrupt the run (it can be resumed)";
}

async function control(action, body) {
  const id = state.runId;
  try {
    const r = await api(`/api/runs/${encodeURIComponent(id)}/${action}`, { method: "POST", body: body ?? {} });
    if (r.message) toast(r.message);
    return r;
  } catch (err) {
    if (action === "resume" && err.status === 409 && /hash mismatch/.test(err.message) && confirm(`${err.message}\n\nResume anyway?`)) return control("resume", { force: true });
    toast(err.message, "error");
  } finally {
    void refreshRuns();
  }
}

function initControls() {
  $("#btn-start").onclick = openStartDialog;
  $("#btn-pause").onclick = () => control("pause");
  $("#btn-stop").onclick = () => control("stop");
  $("#btn-resume").onclick = async () => {
    const t = state.view?.trace;
    const c = state.view?.control;
    if (t?.status === "running" && c?.alive) return control("continue");
    const r = await control("resume");
    if (r?.run_id) toast(`Resuming run ${r.run_id}`);
  };
  $("#start-form").addEventListener("submit", async (ev) => {
    if (ev.submitter?.value !== "start") return;
    ev.preventDefault();
    const err = $("#start-error");
    err.hidden = true;
    let trigger;
    try {
      trigger = JSON.parse($("#trigger-input").value || "{}");
      if (trigger === null || typeof trigger !== "object" || Array.isArray(trigger)) throw new Error("The trigger must be a JSON object");
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      return;
    }
    const body = { trigger };
    const mc = $("#concurrency-input").value;
    if (mc) body.max_concurrency = Number(mc);
    $("#start-submit").disabled = true;
    try {
      const r = await api("/api/runs", { method: "POST", body });
      $("#start-dialog").close();
      toast(`Started run ${r.run_id}`);
      await refreshRuns();
      setFollow(true);
      selectRun(r.run_id);
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    } finally {
      $("#start-submit").disabled = false;
    }
  });
}

/** Prefill from the last run's trigger, else a skeleton from trigger_schema. */
function openStartDialog() {
  const input = $("#trigger-input");
  const schema = state.flow?.trigger_schema;
  if (!input.value) {
    const lastTrigger = state.view?.trace.trigger;
    if (lastTrigger && Object.keys(lastTrigger).length) input.value = json(lastTrigger);
    else {
      const skeleton = {};
      for (const [k, p] of Object.entries(schema?.properties ?? {})) {
        if (!(schema.required ?? []).includes(k)) continue;
        skeleton[k] = p.default ?? (p.type === "integer" || p.type === "number" ? (p.minimum ?? 0) : p.type === "boolean" ? false : p.type === "array" ? [] : p.type === "object" ? {} : "");
      }
      input.value = json(skeleton);
    }
  }
  const props = Object.entries(schema?.properties ?? {});
  $("#trigger-hint").textContent = props.length ? `Fields: ${props.map(([k, p]) => `${k}${(schema.required ?? []).includes(k) ? "*" : ""} (${p.type ?? "any"})`).join(", ")}` : "No trigger_schema; any JSON object is accepted.";
  $("#start-error").hidden = true;
  $("#start-dialog").showModal();
  input.focus();
}

// ---------------------------------------------------------------- panes

function setPane(name, visible) {
  if (state.panes[name] === visible) return;
  state.panes[name] = visible;
  if (visible) state.panesBeforeFocus = null;
  applyPanes();
  try {
    localStorage.setItem(PANES_KEY, JSON.stringify(state.panes));
  } catch {
    /* storage unavailable: the choice just isn't remembered */
  }
}

function togglePane(name) {
  setPane(name, !state.panes[name]);
}

/** Hide every pane, or bring back the ones that were open before. */
function toggleFocusGraph() {
  const anyOpen = PANES.some((p) => state.panes[p]);
  if (anyOpen) {
    const before = { ...state.panes };
    for (const p of PANES) setPane(p, false);
    state.panesBeforeFocus = before;
  } else {
    const restore = state.panesBeforeFocus ?? { runs: true, inspector: true, logs: true };
    for (const p of PANES) setPane(p, restore[p]);
  }
}

function applyPanes() {
  for (const p of PANES) document.body.classList.toggle(`hide-${p}`, !state.panes[p]);
  for (const b of document.querySelectorAll(".view-toggles [data-pane]")) b.setAttribute("aria-pressed", String(state.panes[b.dataset.pane]));
  $("#btn-focus").setAttribute("aria-pressed", String(PANES.every((p) => !state.panes[p])));
  // The graph pane changed size: refit unless the user has panned/zoomed, and keep the popover on its node.
  requestAnimationFrame(() => {
    if (state.followGraph) {
      fitGraph();
      followRunning();
    }
    positionPopover();
  });
}

function initPanes() {
  try {
    const saved = JSON.parse(localStorage.getItem(PANES_KEY) ?? "null");
    if (saved && typeof saved === "object") for (const p of PANES) if (typeof saved[p] === "boolean") state.panes[p] = saved[p];
  } catch {
    /* unreadable or blocked storage: start with everything visible */
  }
  applyPanes();
  for (const b of document.querySelectorAll(".view-toggles [data-pane]")) b.onclick = () => togglePane(b.dataset.pane);
  $("#btn-focus").onclick = toggleFocusGraph;
  for (const b of document.querySelectorAll("[data-hide]")) b.onclick = () => setPane(b.dataset.hide, false);
}

// ---------------------------------------------------------------- theme

const THEMES = [
  { group: null, items: [["", "System"]] },
  {
    group: "Light",
    items: [
      ["light", "Light"],
      ["github-light", "GitHub Light"],
      ["solarized-light", "Solarized Light"],
      ["catppuccin-latte", "Catppuccin Latte"],
      ["rose-pine-dawn", "Rosé Pine Dawn"],
    ],
  },
  {
    group: "Dark",
    items: [
      ["dark", "Dark"],
      ["github-dark", "GitHub Dark"],
      ["vercel", "Vercel"],
      ["linear", "Linear"],
      ["one-dark", "One Dark"],
      ["rose-pine", "Rosé Pine"],
      ["night-owl", "Night Owl"],
      ["nord", "Nord"],
      ["gruvbox", "Gruvbox"],
      ["dracula", "Dracula"],
      ["tokyo-night", "Tokyo Night"],
      ["catppuccin-mocha", "Catppuccin Mocha"],
      ["high-contrast", "High Contrast"],
    ],
  },
];
const THEME_NAMES = new Map(THEMES.flatMap((g) => g.items));

function setTheme(id) {
  if (id) document.documentElement.dataset.theme = id;
  else delete document.documentElement.dataset.theme;
  for (const n of document.querySelectorAll("#theme-name > span")) n.classList.toggle("current", n.dataset.themeId === id);
  for (const b of document.querySelectorAll("#theme-menu [data-theme-id]")) b.setAttribute("aria-checked", String(b.dataset.themeId === id));
  try {
    if (id) localStorage.setItem(THEME_KEY, id);
    else localStorage.removeItem(THEME_KEY);
  } catch {
    /* storage unavailable: the choice just isn't remembered */
  }
}

function toggleThemeMenu(open) {
  const menu = $("#theme-menu");
  menu.hidden = !open;
  $("#theme-btn").setAttribute("aria-expanded", String(open));
  if (open) (menu.querySelector('[aria-checked="true"]') ?? menu.querySelector("button")).focus();
}

/** The theme is applied before first paint by index.html; this builds the picker menu. */
function initTheme() {
  const swatch = (id) => `<span class="swatch${id ? "" : " system"}"${id ? ` data-theme="${id}"` : ""}><i></i><i></i><i></i><i></i></span>`;
  $("#theme-name").innerHTML = [...THEME_NAMES].map(([id, name]) => `<span data-theme-id="${id}">${name}</span>`).join("");
  const menu = $("#theme-menu");
  menu.innerHTML = THEMES.map(
    (g) =>
      (g.group ? `<div class="pop-label">${g.group}</div>` : "") +
      g.items.map(([id, name]) => `<button role="menuitemradio" data-theme-id="${id}">${swatch(id)}<span>${name}</span><span class="check">✓</span></button>`).join(""),
  ).join("");
  // A saved theme that no longer exists falls back to System.
  const current = document.documentElement.dataset.theme ?? "";
  setTheme(THEME_NAMES.has(current) ? current : "");

  $("#theme-btn").onclick = () => toggleThemeMenu(menu.hidden);
  menu.onclick = (ev) => {
    const b = ev.target.closest("[data-theme-id]");
    if (!b) return;
    setTheme(b.dataset.themeId);
    toggleThemeMenu(false);
    $("#theme-btn").focus();
  };
  // Hovering previews the theme; leaving the menu without choosing restores the current one.
  menu.onmouseover = (ev) => {
    const b = ev.target.closest("[data-theme-id]");
    if (!b) return;
    if (b.dataset.themeId) document.documentElement.dataset.theme = b.dataset.themeId;
    else delete document.documentElement.dataset.theme;
  };
  menu.onmouseleave = () => {
    const id = menu.querySelector('[aria-checked="true"]').dataset.themeId;
    if (id) document.documentElement.dataset.theme = id;
    else delete document.documentElement.dataset.theme;
  };
  menu.onkeydown = (ev) => {
    const items = [...menu.querySelectorAll("button")];
    const i = items.indexOf(document.activeElement);
    if (ev.key === "Escape") {
      toggleThemeMenu(false);
      $("#theme-btn").focus();
    } else if (ev.key === "ArrowDown") items[(i + 1) % items.length].focus();
    else if (ev.key === "ArrowUp") items[(i - 1 + items.length) % items.length].focus();
    else return;
    // Keep the graph's arrow/Escape shortcuts from firing too.
    ev.preventDefault();
    ev.stopPropagation();
  };
  document.addEventListener("mousedown", (ev) => {
    if (!menu.hidden && !ev.target.closest("#theme-picker")) {
      toggleThemeMenu(false);
      menu.onmouseleave();
    }
  });
}

// ---------------------------------------------------------------- boot

function renderAll() {
  updateGraphState();
  renderInspector();
  renderLogs();
  renderToolbar();
}

async function loadFlowInfo() {
  let flow;
  try {
    flow = await api("/api/flow");
  } catch (err) {
    if (!state.flow) $("#inspector-body").innerHTML = `<pre class="error">${esc(err.message)}</pre>`;
    else toast(err.message, "error");
    return false;
  }
  if (state.flow && JSON.stringify(flow) === JSON.stringify(state.flow)) return true;
  const graphChanged = !state.flow || JSON.stringify([flow.steps.map((s) => [s.name, s.type, s.terminal]), flow.edges]) !== JSON.stringify([state.flow.steps.map((s) => [s.name, s.type, s.terminal]), state.flow.edges]);
  state.flow = flow;
  $("#flow-name").textContent = flow.name;
  document.title = `${flow.name} · DogYard`;
  if (state.selected && !stepInfo(state.selected)) state.selected = null;
  if (graphChanged) renderGraph();
  renderInspector();
  return true;
}

async function boot() {
  if (!TOKEN) {
    document.body.innerHTML = '<p style="padding:24px">Open the URL printed by <code>dogyard ui</code>; it includes the access token.</p>';
    return;
  }
  initTheme();
  initPanes();
  initPanZoom();
  initKeyboard();
  initInspector();
  initTextDialog();
  initLogs();
  initRunList();
  initControls();
  if (!(await loadFlowInfo())) return;
  await refreshRuns();
  const pick = state.runs.find((r) => r.status === "running") ?? state.runs[0];
  selectRun(pick?.run_id ?? null);
  setInterval(refreshRuns, 3000);
  // Live durations between trace updates.
  setInterval(() => {
    if (state.view?.trace.status !== "running") return;
    updateGraphState();
    renderToolbar();
  }, 1000);
  // Pick up edits to flow.yaml.
  window.addEventListener("focus", () => void loadFlowInfo());
}

void boot();
