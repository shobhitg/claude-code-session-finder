/// <reference lib="dom" />
// Session View DOM glue (D20): header · threaded timeline · agent list | the selected node's pane (Overview,
// Transcript). Logic lives in ./model.ts and core/*; this file turns models into elements and gestures into
// messages. A live session is re-sent every 2 s: the view is rebuilt but keeps what you had open, where you
// had scrolled and which tab you were on; between snapshots only the elapsed times tick.
import type { SessionGraph, GraphNode, NodeStatus } from '../../core/agents.js';
import type { Turn, Item, ToolCall, Overview, Step } from '../../core/transcript.js';
import { fmtDuration } from '../model.js';
import { iconClasses, statusIcon, fmtClock, fmtTokens, toolIcon, modelChip, listModel, threadLayout, nodeMeta, isLive,
         parseMarkdown, parseInline, findPaths, looksJson, recognise, defaultView,
         type MdBlock, type Inline, type JsonView, type Findings } from './model.js';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };
const api = acquireVsCodeApi();

interface Page { nodeId: string; turns: Turn[]; total: number; from: number; overview: Overview }
interface FileInfo {
  found: boolean; path: string; name: string; why: string; via?: string; abs?: string; dir?: string; isDir?: boolean; entries?: number;
  size?: number; mtimeMs?: number; kind?: string; lines?: number; preview?: { start: number; lines: string[]; hl?: number }; image?: string;
}
type Inbound =
  | { type: 'init' | 'update'; sessionId: string; title: string; graph: SessionGraph; now: number; live: boolean; page?: Page; jsonViews?: Record<string, JsonView> }
  | { type: 'page'; page: Page; now: number }
  | { type: 'fileInfo'; key: string; info: FileInfo }
  | { type: 'error'; message: string };
type Tab = 'overview' | 'transcript';
interface UiState { tab: Tab; closed: string[] }

let graph: SessionGraph | null = null;
let title = '';
let live = false;
let clockOffset = 0;
let selected = 'session';
let page: Page | null = null;
let jsonViews: Record<string, JsonView> = {};
const ui: UiState = { tab: 'overview', closed: [], ...(api.getState() as Partial<UiState> | undefined) };
const save = (): void => api.setState(ui);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const root = document.getElementById('app') as HTMLElement;
const post = (m: unknown): void => api.postMessage(m);
const hostNow = (): number => Date.now() + clockOffset;

// ---------------------------------------------------------------- tiny DOM kit

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Array<Node | string | null | undefined | false>): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
const SVGNS = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}
const icon = (name: string, cls = ''): HTMLElement => h('i', { class: `${iconClasses(name)}${cls ? ` ${cls}` : ''}`, 'aria-hidden': 'true' });
/** The running glyph: the sidebar's breathing sparkle (D19), drawn. */
function spark(cls = 'spark'): SVGSVGElement {
  const s = svg('svg', { class: cls, viewBox: '0 0 16 16', 'aria-hidden': 'true' });
  s.append(svg('path', { fill: 'currentColor', d: 'M8 1.6c.45 3.1 1.55 4.5 4.6 6.4-3.05 1.9-4.15 3.3-4.6 6.4-.45-3.1-1.55-4.5-4.6-6.4 3.05-1.9 4.15-3.3 4.6-6.4z' }));
  return s;
}
const statusGlyph = (n: GraphNode, cls: string): Element => isLive(n.status) ? spark(`${cls} spark`) : icon(statusIcon(n.kind, n.status, reducedMotion), cls);
function action(name: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = h('button', { class: 'action', title: label, 'aria-label': label }, icon(name));
  b.addEventListener('click', onClick);
  return b;
}
/** A copy button for a block's corner (D20): copies the block's source text, through the host's clipboard. */
function copyBtn(text: () => string, label = 'Copy'): HTMLButtonElement {
  const b = h('button', { class: 'cp', title: label, 'aria-label': label }, icon('copy'));
  b.addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation();
    post({ type: 'copy', text: text() });
    b.replaceChildren(icon('check')); b.classList.add('cp--done');
    setTimeout(() => { b.replaceChildren(icon('copy')); b.classList.remove('cp--done'); }, 1400);
  });
  return b;
}
const copyable = (el: HTMLElement, text: () => string, label?: string): HTMLElement => { el.classList.add('cpw'); el.append(copyBtn(text, label)); return el; };
const chip = (model: string | undefined): HTMLElement | null => { const c = modelChip(model); return c ? h('span', { class: `chipm chipm--${c.tier}` }, c.label) : null; };
/** A span whose text is "<prefix><elapsed since>", kept current by the 1 s tick. */
const since = (t: number, prefix = '', cls = ''): HTMLElement => h('span', { class: cls, 'data-since': String(t), 'data-prefix': prefix }, `${prefix}${fmtDuration(hostNow() - t)}`);
const statusClass = (s: NodeStatus): string => `st-${s}`;
const modelName = (m?: string): string => (m ?? '').replace(/^claude-/, '');

function select(id: string): void {
  if (!graph?.nodes[id] || id === selected) return;
  selected = id; page = null;
  post({ type: 'select', nodeId: id });
  render();
}

// ---------------------------------------------------------------- header

function renderHeader(): HTMLElement {
  const g = graph!; const n = g.nodes[g.root]!;
  const agents = g.order.length - 1;
  const running = g.order.filter(id => isLive(g.nodes[id]!.status) && id !== g.root).length;
  const meta = [modelName(n.model), `${agents} ${agents === 1 ? 'agent' : 'agents'}`, running ? `${running} running` : undefined].filter((x): x is string => !!x).join(' · ');
  const el = h('header', { class: `header ${statusClass(n.status)}` }, statusGlyph(n, 'header__icon'), h('span', { class: 'header__title', title }, title), h('span', { class: 'header__meta' }, meta));
  if (live) el.append(h('span', { class: 'header__live' }, h('i', { class: 'dot', 'aria-hidden': 'true' }), 'live'));
  el.append(h('span', { class: 'header__actions' },
    action('window', 'Open session in a tab', () => post({ type: 'open', where: 'tab' })),
    action('layout-sidebar-right', 'Open session in the right panel', () => post({ type: 'open', where: 'right' })),
    action('file-code', 'Raw transcript of the selected node', () => post({ type: 'raw', nodeId: selected })),
    action('refresh', 'Re-read from disk', () => post({ type: 'refresh' }))));
  return el;
}

// ---------------------------------------------------------------- the threaded timeline (D20)

function renderTimeline(): HTMLElement {
  const g = graph!; const now = hostNow();
  const width = Math.max(480, (root.clientWidth || 900) - 2);
  const labelW = Math.min(220, Math.round(width * 0.24)), lane = 18, top = 20, gapW = 46;
  const L = threadLayout(g, now, { width, labelW, lane, top, gapW });
  const H = L.height + 16;
  const el = svg('svg', { class: 'tl', width, height: H, viewBox: `0 0 ${width} ${H}`, role: 'img', 'aria-label': 'Timeline: agents as threads off the lane that started them; idle time folded' });
  const defs = svg('defs');
  const grad = (id: string, stops: Array<[number, string, number]>, vertical = false): void => {
    const lg = svg('linearGradient', { id, x1: 0, y1: 0, x2: vertical ? 0 : 1, y2: vertical ? 1 : 0 });
    for (const [o, cls, op] of stops) lg.append(svg('stop', { offset: o, class: cls, 'stop-opacity': op }));
    defs.append(lg);
  };
  grad('tl-live', [[0, 'stop-run', 0.3], [1, 'stop-run', 1]]);
  grad('tl-aurora', [[0, 'stop-run', 1], [0.6, 'stop-cost', 1], [1, 'stop-ok', 1]]);
  el.append(defs);
  for (const gp of L.gaps) {
    el.append(svg('rect', { class: 'tl-gap', x: gp.x + 4, y: top - 4, width: gp.w - 8, height: L.height - top + 4, rx: 5 }));
    let z = `M${gp.x + gp.w / 2 - 3},${top - 4}`; for (let y = top; y < L.height - 2; y += 8) z += ' l6,4 l-6,4';
    el.append(svg('path', { class: 'tl-zig', d: z }));
    const t = svg('text', { class: 'tl-m', x: gp.x + gp.w / 2, y: H - 4, 'text-anchor': 'middle' }); t.textContent = `${fmtDuration(gp.idleMs)} idle`; el.append(t);
  }
  for (const tk of L.ticks) { const t = svg('text', { class: 'tl-m', x: tk.x, y: 12, 'text-anchor': tk.anchor }); t.textContent = tk.label; el.append(t); }
  if (L.nowX !== undefined) {
    el.append(svg('line', { class: 'tl-now', x1: L.nowX, x2: L.nowX, y1: top - 4, y2: L.height }));
    const t = svg('text', { class: 'tl-m tl-m--now', x: L.nowX, y: 12, 'text-anchor': 'end' }); t.textContent = 'now'; el.append(t);
  }
  const byId = new Map(L.lanes.map(l => [l.id, l]));
  const charW = 6.4;
  for (const l of L.lanes) {
    const n = g.nodes[l.id]!;
    const hit = svg('rect', { class: `tl-hit${l.id === selected ? ' tl-hit--sel' : ''}`, x: 0, y: l.y - lane / 2, width, height: lane, tabindex: 0, role: 'button', 'aria-label': n.label });
    hit.addEventListener('click', () => select(l.id));
    hit.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(l.id); } });
    el.append(hit);
    const max = Math.max(6, Math.floor((labelW - 16 - l.depth * 12) / charW));
    const name = n.tag ? `${n.label} · ${n.tag}` : n.label;
    const t = svg('text', { class: `tl-t${l.depth === 0 ? ' tl-t--root' : ''}`, x: 10 + l.depth * 12, y: l.y + 4 });
    t.textContent = name.length > max ? `${name.slice(0, max - 1)}…` : name;
    const tip = svg('title'); tip.textContent = `${name} · ${nodeMeta(n, now) || n.status}`; t.append(tip);
    el.append(t);
  }
  for (const l of L.lanes) {
    if (!l.parent) continue; const p = byId.get(l.parent); if (!p) continue;
    const gEl = svg('g', { class: `${statusClass(l.status)} tl-thread` });
    gEl.append(svg('path', { d: `M${l.x0},${p.y} V${l.y - 3} q0,3 3,3` }), svg('circle', { cx: l.x0, cy: p.y, r: 2, class: 'tl-knot' }));
    el.append(gEl);
  }
  for (const l of L.lanes) {
    const n = g.nodes[l.id]!; const gEl = svg('g', { class: `${statusClass(l.status)} tl-bar` });
    if (l.kind === 'session') {
      for (const sg of L.segs) gEl.append(svg('rect', { x: sg.x0, y: l.y - 2.5, width: Math.max(2, sg.x1 - sg.x0), height: 5, rx: 2.5, fill: 'url(#tl-aurora)' }));
    } else if (l.kind === 'workflow') gEl.append(svg('rect', { class: 'tl-wf', x: l.x0, y: l.y - 5, width: l.x1 - l.x0, height: 10, rx: 5 }));
    else gEl.append(svg('rect', { class: `tl-r${l.open ? ' tl-r--live' : ''}`, x: l.x0, y: l.y - 4.5, width: l.x1 - l.x0, height: 9, rx: 4.5, ...(l.open ? { fill: 'url(#tl-live)' } : {}) }));
    if (l.open && l.kind !== 'session') { gEl.append(svg('circle', { class: 'tl-halo', cx: l.x1, cy: l.y, r: 5 }), svg('circle', { class: 'tl-cap', cx: l.x1, cy: l.y, r: 3.3 })); }
    else if (l.kind === 'agent' && (n.status === 'failed' || n.status === 'stopped')) gEl.append(svg('circle', { class: 'tl-end', cx: l.x1, cy: l.y, r: 3.6 }));
    el.append(gEl);
  }
  return h('section', { class: 'timeline' }, el);
}

// ---------------------------------------------------------------- the agent list (D20)

function nowLine(n: GraphNode): HTMLElement | null {
  if (!n.now) return null;
  return h('span', { class: 'row__now' }, icon(toolIcon(n.now.tool)), h('span', { class: 'shim row__now-what' }, `${n.now.tool} · ${n.now.summary}`), since(n.now.since, '', 'row__since'));
}
function spanBar(n: GraphNode): HTMLElement {
  const g = graph!; const r = g.nodes[g.root]!; const t0 = r.spawnTs ?? n.spawnTs ?? 0; const t1 = Math.max(hostNow(), r.endTs ?? 0); const span = Math.max(1, t1 - t0);
  const s = n.spawnTs ?? t0; const e = n.endTs ?? (isLive(n.status) ? hostNow() : s);
  return h('span', { class: 'span', 'aria-hidden': 'true' }, h('i', { class: isLive(n.status) ? 'live' : '', style: `left:${((s - t0) / span * 100).toFixed(1)}%;width:${Math.max(1.5, (e - s) / span * 100).toFixed(1)}%` }));
}
function listRow(id: string, depth: number): HTMLElement {
  const n = graph!.nodes[id]!;
  const ran = n.durationMs ?? (n.endTs && n.spawnTs ? n.endTs - n.spawnTs : undefined);
  const second = isLive(n.status) && n.now ? nowLine(n)
    : h('span', { class: 'row__meta' }, [n.kind === 'failed-spawn' ? 'spawn failed' : n.subagentType && n.subagentType !== 'general-purpose' ? n.subagentType : '', ran ? fmtDuration(ran) : isLive(n.status) ? 'running' : '', n.background ? 'background' : ''].filter(Boolean).join(' · '), n.kind !== 'session' ? spanBar(n) : null);
  const b = h('button', { class: `row ${statusClass(n.status)}`, 'data-id': id, style: `--depth:${depth}`, title: `${n.label}${n.tag ? ` · ${n.tag}` : ''} — ${nodeMeta(n, hostNow()) || n.status}`, ...(id === selected ? { 'aria-current': 'true' } : {}) },
    statusGlyph(n, 'row__icon'), h('span', { class: 'row__name' }, n.label, n.tag ? h('span', { class: 'row__tag' }, n.tag) : null), chip(n.model) ?? h('span'), second);
  b.addEventListener('click', () => select(id));
  return b;
}
function renderList(): HTMLElement {
  const g = graph!; const nav = h('nav', { class: 'list', 'aria-label': 'Agents' });
  for (const e of listModel(g)) {
    if (e.kind === 'row') { nav.append(listRow(e.id, e.depth)); continue; }
    const w = g.nodes[e.id]!; const closed = ui.closed.includes(e.id);
    const counts = [`${e.rows.length} ${e.rows.length === 1 ? 'agent' : 'agents'}`, ...(['running', 'launched', 'failed', 'stopped'] as NodeStatus[]).filter(s => e.counts[s]).map(s => `${e.counts[s]} ${s === 'launched' ? 'starting' : s}`)];
    const head = h('button', { class: `grp__head ${statusClass(w.status)}`, 'aria-expanded': String(!closed), 'data-id': e.id }, icon('chevron-down', 'grp__chev'), icon('type-hierarchy', 'grp__icon'),
      h('span', { class: 'grp__name' }, w.label), h('span', { class: 'grp__meta' }, counts.join(' · ')));
    head.addEventListener('click', ev => { if ((ev.target as HTMLElement).closest('.grp__chev')) { toggleGroup(e.id); return; } select(e.id); });
    head.addEventListener('dblclick', () => toggleGroup(e.id));
    const strip = h('div', { class: 'grp__strip', 'aria-hidden': 'true' }, ...e.rows.map(r => h('i', { class: statusClass(g.nodes[r.id]!.status) })));
    const grp = h('div', { class: `grp${closed ? ' grp--closed' : ''}${e.id === selected ? ' grp--sel' : ''}` }, head, strip);
    if (!closed) for (const r of e.rows) grp.append(listRow(r.id, r.depth));
    nav.append(grp);
  }
  return nav;
}
function toggleGroup(id: string): void { ui.closed = ui.closed.includes(id) ? ui.closed.filter(x => x !== id) : [...ui.closed, id]; save(); render(); }

// ---------------------------------------------------------------- Markdown, file names, JSON (D20)

/** A file name: hoverable (a card with its details and a preview), clickable (opens it). `cwd` is where it resolves first. */
function fileChip(label: string, path: string, line: number | undefined, cwd: string | undefined): HTMLElement {
  return h('button', { class: 'fp', 'data-path': path, ...(line ? { 'data-line': String(line) } : {}), ...(cwd ? { 'data-cwd': cwd } : {}), title: '' }, label);
}
function inline(nodes: Inline[], cwd: string | undefined): Array<Node | string> {
  return nodes.map(n => {
    switch (n.t) {
      case 'text': return n.v;
      case 'code': { const c = h('code', { class: 'cc', title: 'Click to copy' }, n.v); c.addEventListener('click', () => { post({ type: 'copy', text: n.v }); c.classList.add('cc--done'); setTimeout(() => c.classList.remove('cc--done'), 900); }); return c; }
      case 'strong': return h('strong', {}, ...inline(n.c, cwd));
      case 'link': { const a = h('a', { href: '#', title: n.href }, ...inline(n.c, cwd)); a.addEventListener('click', e => { e.preventDefault(); post({ type: 'openUrl', href: n.href }); }); return a; }
      case 'path': return fileChip(n.label, n.path, n.line, cwd);
    }
  });
}
const textWithFiles = (text: string, cwd: string | undefined): Array<Node | string> => {
  const out: Array<Node | string> = []; let at = 0;
  for (const p of findPaths(text)) { if (p.start > at) out.push(text.slice(at, p.start)); out.push(fileChip(p.raw, p.path, p.line, cwd)); at = p.end; }
  if (at < text.length) out.push(text.slice(at));
  return out;
};
function blocks(bs: MdBlock[], cwd: string | undefined): HTMLElement[] {
  return bs.map(b => {
    switch (b.t) {
      case 'p': return h('p', {}, ...inline(b.c, cwd));
      case 'h': return h(b.level <= 2 ? 'h4' : 'h5', {}, ...inline(b.c, cwd));
      case 'hr': return h('hr');
      case 'list': { const l = h(b.ordered ? 'ol' : 'ul', b.ordered && b.start !== 1 ? { start: String(b.start) } : {}); for (const it of b.items) l.append(h('li', {}, ...inline(it, cwd))); return l; }
      case 'code': return copyable(h('div', { class: 'codeblock' }, h('pre', {}, b.v)), () => b.v, 'Copy code');
      case 'quote': return h('blockquote', {}, ...blocks(b.c, cwd));
      case 'table': {
        const t = h('table', { class: 'mdt' }); const tr = h('tr'); for (const c of b.head) tr.append(h('th', {}, ...inline(c, cwd)));
        t.append(h('thead', {}, tr)); const tb = h('tbody'); for (const r of b.rows) { const row = h('tr'); for (const c of r) row.append(h('td', {}, ...inline(c, cwd))); tb.append(row); }
        t.append(tb); return h('div', { class: 'mdt-wrap' }, t);
      }
      case 'tag': return h('div', { class: 'tagsec' }, h('span', { class: 'tagsec__label' }, b.name), h('div', { class: 'md' }, ...blocks(b.c, cwd)));
      case 'insight': { const box = h('div', { class: 'insight' }, h('span', { class: 'insight__label' }, icon('star-full'), 'Insight'), h('div', { class: 'md' }, ...blocks(b.c, cwd))); return copyable(box, () => box.querySelector('.md')?.textContent ?? '', 'Copy insight'); }
    }
  });
}
/** A prompt or a reply, laid out as Markdown (never reworded), with a copy button for its source. */
const markdown = (src: string, cwd: string | undefined, cls = ''): HTMLElement => copyable(h('div', { class: `md${cls ? ` ${cls}` : ''}` }, ...blocks(parseMarkdown(src), cwd)), () => src);

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** JSON, indented and coloured; strings that name files become file names. Built as escaped HTML for speed. */
function prettyHtml(v: unknown, cwd: string | undefined, ind = 0): string {
  const pad = '  '.repeat(ind), pad1 = '  '.repeat(ind + 1);
  if (v === null || typeof v === 'boolean') return `<span class="j-lit">${String(v)}</span>`;
  if (typeof v === 'number') return `<span class="j-num">${v}</span>`;
  if (typeof v === 'string') {
    const s = JSON.stringify(v); let out = ''; let at = 0;
    for (const p of findPaths(s)) { out += esc(s.slice(at, p.start)) + `<button class="fp" data-path="${esc(p.path)}"${p.line ? ` data-line="${p.line}"` : ''}${cwd ? ` data-cwd="${esc(cwd)}"` : ''}>${esc(p.raw)}</button>`; at = p.end; }
    return `<span class="j-str">${out}${esc(s.slice(at))}</span>`;
  }
  if (Array.isArray(v)) return v.length ? `<span class="j-pun">[</span>\n${v.map(x => pad1 + prettyHtml(x, cwd, ind + 1)).join('<span class="j-pun">,</span>\n')}\n${pad}<span class="j-pun">]</span>` : '<span class="j-pun">[]</span>';
  const ks = Object.keys(v as object);
  return ks.length ? `<span class="j-pun">{</span>\n${ks.map(k => `${pad1}<span class="j-key">${esc(JSON.stringify(k))}</span><span class="j-pun">: </span>${prettyHtml((v as Record<string, unknown>)[k], cwd, ind + 1)}`).join('<span class="j-pun">,</span>\n')}\n${pad}<span class="j-pun">}</span>` : '<span class="j-pun">{}</span>';
}
function findingsView(f: Findings, cwd: string | undefined): HTMLElement {
  const box = h('div', { class: 'findings' });
  if (f.verdict) box.append(h('p', { class: 'verdict' }, ...inline(parseInline(f.verdict), cwd)));
  for (const x of f.findings) {
    const sev = (x.severity ?? '').toLowerCase();
    const card = h('div', { class: `finding finding--${/crit|major|high|block/.test(sev) ? 'major' : /minor|low|nit/.test(sev) ? 'minor' : 'info'}` },
      h('div', { class: 'finding__head' }, x.severity ? h('span', { class: 'finding__sev' }, x.severity) : null, x.title ? h('span', { class: 'finding__title' }, ...inline(parseInline(x.title), cwd)) : null,
        x.file ? fileChip(`${x.file.split('/').pop()}${x.line ? `:${x.line}` : ''}`, x.file, x.line ? Number(x.line) || undefined : undefined, cwd) : null),
      x.evidence ? h('div', { class: 'finding__ev' }, ...inline(parseInline(x.evidence), cwd)) : null,
      x.failure_scenario ? h('div', { class: 'finding__fs' }, 'If it happens: ', ...inline(parseInline(x.failure_scenario), cwd)) : null);
    box.append(copyable(card, () => [`${x.severity ?? ''} · ${x.title ?? ''}${x.file ? ` — ${x.file}${x.line ? `:${x.line}` : ''}` : ''}`, x.evidence ?? '', x.failure_scenario ? `If it happens: ${x.failure_scenario}` : ''].filter(Boolean).join('\n'), 'Copy finding'));
  }
  return box;
}
/**
 * JSON (D20): Formatted when its shape is known, else Pretty; the dump past JSON_BIG, or when chosen. The view
 * you pick sticks for that tool (remembered by the host). Copy gives what the view shows, as text.
 */
function jsonBlock(src: string | Record<string, unknown>, tool: string, cwd: string | undefined, key: string): HTMLElement {
  const raw = typeof src === 'string' ? src : JSON.stringify(src);
  let parsed: unknown = typeof src === 'string' ? undefined : src; let parsedOk = typeof src !== 'string';
  const parse = (): unknown => { if (!parsedOk) { try { parsed = JSON.parse(raw); parsedOk = true; } catch { parsedOk = false; } } return parsed; };
  const big = raw.length > 100 * 1024;
  const known = big ? undefined : recognise(parse());
  if (!big && typeof src === 'string' && !parsedOk) return outputText(raw, cwd);                      // looked like JSON, wasn't
  const box = h('div', { class: 'json', 'data-k': key });
  const bar = h('div', { class: 'json__bar' }, h('span', {}, `JSON · ${raw.length >= 1024 ? `${(raw.length / 1024).toFixed(1)} KB` : `${raw.length} B`}`));
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'JSON view' });
  const views: JsonView[] = [...(known ? ['formatted' as JsonView] : []), 'pretty', 'raw'];
  const note = h('span', { class: 'json__note' });
  const body = h('div', { class: 'json__body' });
  let view = defaultView(raw.length, !!known, jsonViews[tool]);
  const show = (v: JsonView): void => {
    view = v; body.replaceChildren();
    if (v === 'raw') body.append(h('pre', { class: 'out out--raw' }, ...textWithFiles(raw, cwd)));
    else if (v === 'formatted' && known) body.append(findingsView(known, cwd));
    else { const pre = h('pre', { class: 'out' }); pre.innerHTML = prettyHtml(parse(), cwd); body.append(pre); }
    for (const b of Array.from(seg.children) as HTMLElement[]) b.setAttribute('aria-pressed', String(b.dataset.view === v));
    note.textContent = big && v === 'raw' ? `${(raw.length / 1048576).toFixed(1)} MB — shown as the dump; Pretty formats it on a click` : '';
  };
  for (const v of views) {
    const b = h('button', { 'data-view': v, 'aria-pressed': 'false' }, v === 'formatted' ? 'Formatted' : v === 'pretty' ? 'Pretty' : 'Dump');
    b.addEventListener('click', () => { show(v); jsonViews[tool] = v; post({ type: 'jsonView', tool, view: v }); });
    seg.append(b);
  }
  bar.append(seg, note); box.append(bar, copyable(body, () => view === 'raw' ? raw : JSON.stringify(parse(), null, 2), 'Copy JSON'));
  show(view);
  return box;
}
/** Tool output that is not JSON: a Read's numbered lines keep their numbers apart; file names are live. */
function outputText(text: string, cwd: string | undefined, err = false): HTMLElement {
  const pre = h('pre', { class: `out${err ? ' out--err' : ''}` });
  const numbered = /^\s*\d+→/.test(text);
  if (numbered) for (const line of text.split('\n')) { const m = /^(\s*\d+→)(.*)$/.exec(line); pre.append(m ? h('span', { class: 'ln' }, m[1]!) : '', ...textWithFiles(m ? m[2]! : line, cwd), '\n'); }
  else pre.append(...textWithFiles(text, cwd));
  return copyable(h('div', { class: 'outwrap' }, pre), () => numbered ? text.split('\n').map(l => l.replace(/^\s*\d+→/, '')).join('\n') : text, 'Copy output');
}

// ---------------------------------------------------------------- the transcript tab

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
function toolInput(c: ToolCall, cwd: string | undefined, key: string): HTMLElement | null {
  const inp = c.input;
  if (c.name === 'Bash' && typeof inp.command === 'string') {
    const cmd = inp.command as string;
    return copyable(h('div', { class: 'codeblock codeblock--cmd' }, typeof inp.description === 'string' ? h('div', { class: 'cmd__desc' }, inp.description as string) : null, h('pre', {}, cmd)), () => cmd, 'Copy command');
  }
  const rest: Record<string, unknown> = { ...inp };
  const fp = FILE_TOOLS.has(c.name) ? (inp.file_path ?? inp.notebook_path) : undefined;
  if (typeof fp === 'string') { delete rest.file_path; delete rest.notebook_path; }
  for (const k of Object.keys(rest)) { const v = rest[k]; if (typeof v === 'string' && v.length > 4000) rest[k] = `${v.slice(0, 4000)}… (${v.length - 4000} more characters)`; }
  const head = typeof fp === 'string' ? h('div', { class: 'tool__file' }, icon('file'), fileChip(fp, fp, typeof inp.offset === 'number' ? (inp.offset as number) : undefined, cwd)) : null;
  const hasRest = Object.keys(rest).length > 0;
  if (!head && !hasRest) return null;
  return h('div', { class: 'tool__in' }, head, hasRest ? jsonBlock(rest, `${c.name}:input`, cwd, `${key}-in`) : null);
}
function renderTool(c: ToolCall, cwd: string | undefined, key: string): HTMLElement {
  const d = document.createElement('details');
  d.className = `tool${c.result?.isError ? ' tool--error' : ''}${c.result ? '' : ' tool--pending'}`; d.dataset.k = key;
  const target = c.agentId && graph ? Object.values(graph.nodes).find(n => n.agentId === c.agentId) : undefined;
  const fp = FILE_TOOLS.has(c.name) && typeof (c.input.file_path ?? c.input.notebook_path) === 'string' ? String(c.input.file_path ?? c.input.notebook_path) : undefined;
  const sum = h('summary', {}, icon(toolIcon(c.name), 'tool__icon'), h('span', { class: 'tool__name' }, c.name),
    fp ? h('span', { class: 'tool__what' }, fileChip(fp.split('/').pop() ?? fp, fp, undefined, cwd)) : h('span', { class: 'tool__what' }, c.summary),
    h('span', { class: 'tool__meta' }, c.result ? `${fmtDuration(c.result.ts - c.ts)}${c.result.isError ? ' · error' : ''}${c.result.images ? ` · ${c.result.images} image${c.result.images > 1 ? 's' : ''}` : ''}` : '', c.result ? '' : since(c.ts, 'running · ')));
  if (target) { const link = h('button', { class: 'tool__link' }, 'open agent →'); link.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); select(target.id); }); sum.append(link); }
  d.append(sum);
  const body = h('div', { class: 'tool__body' });
  d.addEventListener('toggle', () => {                       // built on first open: a long transcript stays light
    if (!d.open || body.childElementCount) return;
    const inp = toolInput(c, cwd, key); if (inp) body.append(inp);
    if (c.result) {
      const t = c.result.text;
      body.append(looksJson(t) && !c.result.isError ? jsonBlock(t, c.name, cwd, `${key}-out`) : outputText(t, cwd, c.result.isError));
      if (c.result.truncated) body.append(h('div', { class: 'note' }, `… ${c.result.truncated.toLocaleString()} more characters — the raw transcript has them`));
    }
  });
  d.append(body);
  return d;
}
function renderItems(items: Item[], cwd: string | undefined, tkey: string): HTMLElement[] {
  const out: HTMLElement[] = []; let hidden = 0;
  const flush = (): void => { if (hidden) out.push(h('div', { class: 'nokept' }, icon('lightbulb'), `${hidden} ${hidden === 1 ? 'thought' : 'thoughts'} not kept in the transcript`)); hidden = 0; };
  items.forEach((it, i) => {
    if (it.kind === 'thinking' && !it.text) { hidden++; return; }
    flush();
    const key = `${tkey}-${i}`;
    switch (it.kind) {
      case 'text': out.push(markdown(it.text, cwd, 'reply')); break;
      case 'thinking': {
        const text = it.text!; const first = text.split('\n')[0]!.slice(0, 200); const lines = text.split('\n').filter(l => l.trim()).length;
        const d = document.createElement('details'); d.className = 'think'; d.dataset.k = key;
        d.append(h('summary', {}, icon('lightbulb', 'think__icon'), h('span', { class: 'think__first' }, first), h('span', { class: 'think__meta' }, `thought${lines > 1 ? ` · ${lines} lines` : ''}`)),
                 h('div', { class: 'think__rest' }, ...blocks(parseMarkdown(text), cwd)));
        out.push(copyable(d, () => text, 'Copy thought')); break;
      }
      case 'image': out.push(h('div', { class: 'image' }, h('img', { src: it.dataUrl, alt: 'image from the prompt', loading: 'lazy' }))); break;
      case 'tool': out.push(renderTool(it.call, cwd, key)); break;
      case 'context': {
        const d = document.createElement('details'); d.className = 'context'; d.dataset.k = key;
        const head = it.text.replace(/^<[a-z-]+>\s*/i, '').split('\n')[0] ?? '';
        d.append(h('summary', {}, icon('info'), `context · ${head.slice(0, 80)}${head.length > 80 ? '…' : ''} · ${fmtTokens(it.text.length)} chars`),
                 h('pre', { class: 'out' }, it.text.length > 6000 ? `${it.text.slice(0, 6000)}\n… ${it.text.length - 6000} more characters — see the raw transcript` : it.text));
        out.push(copyable(d, () => it.text, 'Copy context')); break;
      }
    }
  });
  flush();
  return out;
}
function renderTurn(t: Turn, cwdFallback: string | undefined): HTMLElement {
  const cwd = t.cwd ?? cwdFallback;
  const art = h('article', { class: `turn turn--${t.promptKind}` });
  const dur = t.durationMs ?? (t.endTs > t.startTs ? t.endTs - t.startTs : 0);
  const meta = [fmtClock(t.startTs), dur ? fmtDuration(dur) : undefined, t.outputTokens ? `${fmtTokens(t.outputTokens)} out` : undefined].filter(Boolean).join(' · ');
  const who = t.promptKind === 'notification' ? 'background agent' : t.promptKind === 'meta' ? 'context' : t.promptKind === 'command' ? 'command' : t.index === 0 && selected !== graph?.root ? 'task' : 'you';
  art.append(h('div', { class: 'turn__who' }, who, h('span', {}, meta)));
  if (t.prompt) art.append(t.promptKind === 'command' ? h('div', { class: 'codeblock codeblock--cmd' }, h('pre', {}, t.prompt)) : markdown(t.prompt, cwd, 'prompt'));
  for (const el of renderItems(t.items, cwd, `t${t.index}`)) art.append(el);
  return art;
}
function renderTranscript(n: GraphNode): HTMLElement {
  const sec = h('div', { class: 'transcript' });
  if (!page) { sec.append(h('div', { class: 'empty' }, 'Loading…')); return sec; }
  if (page.from > 0) { const more = h('button', { class: 'more' }, `Show earlier turns (${page.from} more)`); more.addEventListener('click', () => post({ type: 'more', nodeId: page!.nodeId, from: Math.max(0, page!.from - 40) })); sec.append(more); }
  if (!page.turns.length) sec.append(h('div', { class: 'empty' }, n.file ? 'Nothing conversational in this transcript yet.' : 'This node has no transcript file — a denied spawn, or a workflow shell.'));
  for (const t of page.turns) sec.append(renderTurn(t, n.cwd));
  return sec;
}

// ---------------------------------------------------------------- the overview tab

function stepRow(s: Step, cwd: string | undefined): HTMLElement {
  const st = s.status === 'running' ? 'running' : s.status === 'error' ? 'failed' : 'completed';
  return h('li', { class: `step st-${st}` }, h('span', { class: 'step__time' }, fmtClock(s.ts).slice(0, 5)), h('span', { class: 'step__dot' }, icon(toolIcon(s.tool))),
    h('span', { class: 'step__text' }, h('b', {}, s.tool), ' ', ...textWithFiles(s.summary, cwd)),
    h('span', { class: 'step__dur' }, s.status === 'running' ? since(s.ts) : s.ms !== undefined ? fmtDuration(s.ms) : ''));
}
function section(title: string, ...body: Array<Node | null>): HTMLElement { return h('section', { class: 'sec' }, h('h3', { class: 'sec__h' }, title), ...body.filter((x): x is Node => !!x)); }
function renderOverview(n: GraphNode): HTMLElement {
  const box = h('div', { class: 'overview' });
  const o = page?.overview;
  if (n.kind === 'workflow') {
    const kids = n.children.map(id => graph!.nodes[id]!).filter(Boolean);
    const list = h('div', { class: 'kids' }, ...kids.map(k => listRow(k.id, 0)));
    box.append(section(`${kids.length} ${kids.length === 1 ? 'agent' : 'agents'}`, list));
    return box;
  }
  if (!o) { box.append(h('div', { class: 'empty' }, 'Loading…')); return box; }
  if (o.task) { const task = markdown(o.task, n.cwd, 'task'); task.classList.add('clamp'); const more = h('button', { class: 'more more--inline' }, 'Show all'); more.addEventListener('click', () => { task.classList.toggle('clamp'); more.textContent = task.classList.contains('clamp') ? 'Show all' : 'Show less'; }); box.append(section(n.kind === 'session' ? 'First prompt' : 'Task', task, o.task.split('\n').length > 6 || o.task.length > 600 ? more : null)); }
  if (isLive(n.status)) {
    const step = n.now ?? (o.running ? { tool: o.running.tool, summary: o.running.summary, since: o.running.ts } : undefined);
    const card = h('div', { class: 'nowcard' });
    if (step) card.append(h('div', { class: 'nowcard__head' }, icon(toolIcon(step.tool)), h('b', {}, step.tool), h('span', { class: 'nowcard__what' }, ...textWithFiles(step.summary, n.cwd)), since(step.since, '', 'nowcard__since')));
    else card.append(h('div', { class: 'nowcard__head' }, spark('spark'), h('span', { class: 'shim' }, 'working')));
    if (o.lastText) card.append(h('div', { class: 'nowcard__said' }, h('span', { class: 'nowcard__label' }, 'Latest'), ...blocks(parseMarkdown(o.lastText.length > 600 ? `${o.lastText.slice(0, 600)}…` : o.lastText), n.cwd)));
    box.append(section('Now', card));
  }
  if (o.steps.length) {
    const ul = h('ul', { class: 'steps' }, ...o.steps.map(s => stepRow(s, n.cwd)));
    const earlier = o.totalSteps - o.steps.length;
    const more = earlier > 0 ? h('button', { class: 'more more--inline' }, `${earlier} earlier ${earlier === 1 ? 'step' : 'steps'} — in the transcript`) : null;
    more?.addEventListener('click', () => setTab('transcript'));
    box.append(section(`Steps · ${o.totalSteps} tool ${o.totalSteps === 1 ? 'call' : 'calls'}`, more, ul));
  }
  if (!isLive(n.status)) {
    if (n.error) box.append(section('Failed', h('div', { class: 'result result--failed' }, n.error)));
    else if (o.lastText) box.append(section(n.status === 'failed' ? 'Last words' : n.status === 'stopped' ? 'Where it stopped' : 'Result', markdown(o.lastText, n.cwd, `result result--${n.status}`)));
  }
  const kids = n.children.map(id => graph!.nodes[id]!).filter(Boolean);
  if (kids.length && n.kind !== 'session') box.append(section(`Started ${kids.length} ${kids.length === 1 ? 'agent' : 'agents'}`, h('div', { class: 'kids' }, ...kids.map(k => listRow(k.id, 0)))));
  return box;
}

// ---------------------------------------------------------------- the pane

function setTab(t: Tab): void { ui.tab = t; save(); render(); }
function renderPane(): HTMLElement {
  const g = graph!; const n = g.nodes[selected] ?? g.nodes[g.root]!;
  const path: GraphNode[] = []; for (let x: GraphNode | undefined = n; x; x = x.parentId ? g.nodes[x.parentId] : undefined) path.unshift(x);
  const crumbs = h('div', { class: 'crumbs' });
  path.forEach((x, i) => {
    if (i === path.length - 1) { crumbs.append(h('b', {}, x.label)); return; }
    const b = h('button', {}, x.label.length > 36 ? `${x.label.slice(0, 35)}…` : x.label); b.addEventListener('click', () => select(x.id)); crumbs.append(b, h('span', { 'aria-hidden': 'true' }, '›'));
  });
  const ran = n.durationMs ?? (n.endTs && n.spawnTs ? n.endTs - n.spawnTs : undefined);
  const pill = h('span', { class: `pill ${statusClass(n.status)}` }, isLive(n.status) && n.spawnTs ? since(n.spawnTs, `${n.status === 'launched' ? 'starting' : 'running'} · `, 'shim') : n.kind === 'failed-spawn' ? 'spawn failed' : n.status);
  const stats = h('div', { class: 'stats' },
    n.spawnTs ? h('span', {}, 'started ', h('b', {}, fmtClock(n.spawnTs))) : null,
    !isLive(n.status) && ran ? h('span', {}, 'ran ', h('b', {}, fmtDuration(ran))) : null,
    (n.toolUses ?? page?.overview.totalSteps) ? h('span', {}, 'tool calls ', h('b', {}, String(n.toolUses ?? page?.overview.totalSteps))) : null,
    n.totalTokens ? h('span', {}, 'tokens ', h('b', {}, fmtTokens(n.totalTokens))) : null,
    n.subagentType ? h('span', {}, 'type ', h('b', {}, n.subagentType)) : null,
    n.background ? h('span', {}, h('b', {}, 'background')) : null);
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  for (const [t, label] of [['overview', 'Overview'], ['transcript', 'Transcript']] as Array<[Tab, string]>) {
    const b = h('button', { role: 'tab', 'aria-selected': String(ui.tab === t), class: ui.tab === t ? 'on' : '' }, label);
    b.addEventListener('click', () => setTab(t)); tabs.append(b);
  }
  const head = h('div', { class: 'pane__head' }, crumbs,
    h('div', { class: `pane__title ${statusClass(n.status)}` }, statusGlyph(n, 'pane__icon'), h('h2', {}, n.label, n.tag ? h('span', { class: 'row__tag' }, n.tag) : null), pill, chip(n.model)),
    stats, tabs);
  const body = h('div', { class: 'pane__body' }, ui.tab === 'overview' ? renderOverview(n) : renderTranscript(n));
  return h('section', { class: 'pane', 'aria-label': n.label }, head, body);
}

// ---------------------------------------------------------------- composition: rebuild, keep what you had open

function render(): void {
  if (!graph) return;
  const keep = {
    tl: root.querySelector('.timeline')?.scrollTop ?? 0, list: root.querySelector('.list')?.scrollTop ?? 0,
    body: root.querySelector('.pane__body') as HTMLElement | null, open: new Set(Array.from(root.querySelectorAll<HTMLElement>('details[open][data-k]')).map(d => d.dataset.k!)),
    pageKey: root.querySelector<HTMLElement>('.pane')?.dataset.page,
  };
  const stick = keep.body ? keep.body.scrollHeight - keep.body.scrollTop - keep.body.clientHeight < 40 : false;
  const bodyTop = keep.body?.scrollTop ?? 0;
  const pane = renderPane(); pane.dataset.page = `${selected}:${ui.tab}`;
  root.replaceChildren(renderHeader(), renderTimeline(), h('div', { class: 'body' }, renderList(), pane));
  for (const d of Array.from(root.querySelectorAll<HTMLDetailsElement>('details[data-k]'))) if (keep.open.has(d.dataset.k!)) d.open = true;
  (root.querySelector('.timeline') as HTMLElement).scrollTop = keep.tl;
  (root.querySelector('.list') as HTMLElement).scrollTop = keep.list;
  const body = root.querySelector('.pane__body') as HTMLElement;
  if (keep.pageKey === pane.dataset.page) body.scrollTop = live && stick && ui.tab === 'transcript' ? body.scrollHeight : bodyTop;
  else if (ui.tab === 'transcript') body.scrollTop = body.scrollHeight;
}

/** Between snapshots only the elapsed times change. */
function tick(): void {
  const now = hostNow();
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-since]'))) el.textContent = `${el.dataset.prefix ?? ''}${fmtDuration(now - Number(el.dataset.since))}`;
}

// ---------------------------------------------------------------- file cards (D20)

const card = h('div', { class: 'fcard', role: 'dialog', 'aria-label': 'File details', hidden: '' });
document.body.append(card);
const infos = new Map<string, FileInfo>();
let cardFor: HTMLElement | null = null; let showT = 0; let hideT = 0;
const keyOf = (el: HTMLElement): string => `${el.dataset.cwd ?? ''}|${el.dataset.path}|${el.dataset.line ?? ''}`;
const fmtSize = (n: number): string => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
const ago = (t: number): string => { const d = Date.now() - t; return d < 60_000 ? 'just now' : `${fmtDuration(d)} ago`; };
function fillCard(el: HTMLElement, info: FileInfo): void {
  const line = el.dataset.line ? Number(el.dataset.line) : undefined;
  const warn = !info.found || info.via === 'main-checkout';
  const parts: Array<Node | null> = [
    h('div', { class: 'fcard__head' }, icon(info.isDir ? 'folder' : info.image ? 'file-media' : 'file'), h('b', {}, `${info.name}${line ? `:${line}` : ''}`)),
    h('div', { class: 'fcard__path' }, info.abs ?? info.path),
    info.found ? h('div', { class: 'fcard__meta' }, info.kind ? h('span', {}, h('b', {}, info.kind)) : null, info.isDir ? h('span', {}, h('b', {}, String(info.entries ?? 0)), ' items')
      : info.size !== undefined ? h('span', {}, 'size ', h('b', {}, fmtSize(info.size))) : null, info.lines ? h('span', {}, h('b', {}, info.lines.toLocaleString()), ' lines') : null,
      info.mtimeMs ? h('span', {}, 'changed ', h('b', {}, ago(info.mtimeMs))) : null, info.dir ? h('span', {}, 'in ', h('b', {}, info.dir.split('/').slice(-2).join('/'))) : null) : null,
    h('div', { class: `fcard__why${warn ? ' fcard__why--warn' : ''}` }, info.why),
    info.image ? h('img', { class: 'fcard__img', src: info.image, alt: info.name }) : null,
    info.preview ? (() => { const pre = h('pre', { class: 'fcard__prev' }); info.preview!.lines.forEach((l, i) => { const n = info.preview!.start + i; pre.append(h('span', { class: n === info.preview!.hl ? 'hl' : '' }, `${String(n).padStart(4)}  ${l}`), '\n'); }); return pre; })() : null,
    info.found ? h('div', { class: 'fcard__acts' }, (() => { const b = h('button', { class: 'btn btn--primary' }, info.isDir ? 'Reveal' : `Open${line ? ` at line ${line}` : ''}`); b.addEventListener('click', () => openEl(el)); return b; })(),
      (() => { const b = h('button', { class: 'btn' }, 'Copy path'); b.addEventListener('click', () => post({ type: 'copy', text: info.abs ?? info.path })); return b; })()) : null];
  card.replaceChildren(...parts.filter((x): x is Node => x !== null));
  el.classList.toggle('fp--gone', info.found && info.via === 'main-checkout'); el.classList.toggle('fp--missing', !info.found);
}
function place(el: HTMLElement): void {
  const r = el.getBoundingClientRect(); card.hidden = false;
  const w = Math.min(400, window.innerWidth - 16); card.style.width = `${w}px`;
  card.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  const below = r.bottom + 6; const hgt = card.offsetHeight;
  card.style.top = `${below + hgt > window.innerHeight - 8 && r.top - hgt - 6 > 8 ? r.top - hgt - 6 : below}px`;
}
function openCard(el: HTMLElement): void {
  cardFor = el; const k = keyOf(el); const info = infos.get(k);
  if (info) { fillCard(el, info); place(el); return; }
  card.replaceChildren(h('div', { class: 'fcard__head' }, icon('file'), h('b', {}, el.dataset.path!.split('/').pop() ?? '')), h('div', { class: 'fcard__why' }, 'Looking…')); place(el);
  post({ type: 'fileInfo', key: k, path: el.dataset.path, ...(el.dataset.line ? { line: Number(el.dataset.line) } : {}), ...(el.dataset.cwd ? { cwd: el.dataset.cwd } : {}) });
}
const closeCard = (): void => { card.hidden = true; cardFor = null; };
const openEl = (el: HTMLElement): void => post({ type: 'openFile', path: el.dataset.path, ...(el.dataset.line ? { line: Number(el.dataset.line) } : {}), ...(el.dataset.cwd ? { cwd: el.dataset.cwd } : {}) });
document.addEventListener('mouseover', e => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.fp');
  if (el) { clearTimeout(hideT); if (el !== cardFor) { clearTimeout(showT); showT = window.setTimeout(() => openCard(el), 260); } return; }
  if ((e.target as HTMLElement).closest('.fcard')) { clearTimeout(hideT); return; }
  clearTimeout(showT); if (!card.hidden) { clearTimeout(hideT); hideT = window.setTimeout(closeCard, 220); }
});
document.addEventListener('focusin', e => { const el = (e.target as HTMLElement).closest<HTMLElement>('.fp'); if (el) openCard(el); });
document.addEventListener('click', e => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.fp');
  if (el) { e.preventDefault(); e.stopPropagation(); const info = infos.get(keyOf(el)); if (info && !info.found) openCard(el); else openEl(el); return; }
  if (!(e.target as HTMLElement).closest('.fcard')) closeCard();
}, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCard(); });
document.addEventListener('scroll', () => { if (!card.hidden) closeCard(); }, true);

// ---------------------------------------------------------------- messages

window.addEventListener('message', (e: MessageEvent<Inbound>) => {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'error') { root.replaceChildren(h('div', { class: 'empty' }, m.message)); return; }
  if (m.type === 'fileInfo') {
    infos.set(m.key, m.info);
    if (cardFor && keyOf(cardFor) === m.key) { fillCard(cardFor, m.info); place(cardFor); }
    return;
  }
  clockOffset = m.now - Date.now();
  if (m.type === 'init' || m.type === 'update') {
    graph = m.graph; title = m.title; live = m.live;
    if (m.jsonViews) jsonViews = m.jsonViews;
    if (m.page) { page = m.page; selected = m.page.nodeId; }
    if (!graph.nodes[selected]) selected = graph.root;
    render();
    return;
  }
  if (m.type === 'page') {
    if (m.page.nodeId !== selected) return;                      // a stale answer for a node we left
    page = m.page;
    render();
  }
});
setInterval(tick, 1_000);
let resizeT = 0;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = window.setTimeout(render, 150); });
post({ type: 'ready' });
