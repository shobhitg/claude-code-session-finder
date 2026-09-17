/// <reference lib="dom" />
// Session View DOM glue: header · timeline (SVG) · agent tree · transcript reader.
// Logic lives in ./model.ts and core/*; this file turns models into elements and gestures into messages.
import type { SessionGraph, GraphNode } from '../../core/agents.js';
import { bars } from '../../core/agents.js';
import type { Turn, Item, ToolCall } from '../../core/transcript.js';
import { fmtDuration } from '../model.js';
import { treeRows, layoutTimeline, iconClasses, statusIcon, fmtClock, fmtTokens, toolIcon } from './model.js';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };
const api = acquireVsCodeApi();

interface Page { nodeId: string; turns: Turn[]; total: number; from: number }
interface GraphMsg { type: 'init' | 'update'; sessionId: string; title: string; graph: SessionGraph; now: number; live: boolean; page?: Page }
interface PageMsg { type: 'page'; page: Page; now: number }
interface ErrorMsg { type: 'error'; message: string }
type Inbound = GraphMsg | PageMsg | ErrorMsg;

let graph: SessionGraph | null = null;
let title = '';
let live = false;
let clockOffset = 0;
let selected = 'session';
let page: Page | null = null;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const root = document.getElementById('app') as HTMLElement;
const post = (m: unknown): void => api.postMessage(m);
const hostNow = (): number => Date.now() + clockOffset;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) el.append(c);
  return el;
}
const SVG = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}
function action(icon: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = h('button', { class: 'action', title: label, 'aria-label': label }, h('i', { class: `codicon codicon-${icon}`, 'aria-hidden': 'true' }));
  b.addEventListener('click', onClick);
  return b;
}

function select(id: string): void {
  if (!graph?.nodes[id]) return;
  selected = id;
  post({ type: 'select', nodeId: id });
  renderTop();
}

// ---------------------------------------------------------------- header + timeline + tree

function renderHeader(): HTMLElement {
  const g = graph!; const n = g.nodes[g.root]!;
  const agents = g.order.length - 1;
  const running = g.order.filter(id => { const s = g.nodes[id]!.status; return s === 'running' || s === 'launched'; }).length;
  const meta = [n.model?.replace(/^claude-/, ''), `${agents} ${agents === 1 ? 'agent' : 'agents'}`, running ? `${running} running` : undefined]
    .filter((x): x is string => !!x).join(' · ');
  const el = h('header', { class: 'header' },
    h('i', { class: `header__icon ${iconClasses(statusIcon(n.kind, n.status, reducedMotion))}`, 'aria-hidden': 'true' }),
    h('span', { class: 'header__title', title }, title),
    h('span', { class: 'header__meta' }, meta));
  if (live) el.append(h('span', { class: 'header__live' }, '● live'));
  el.append(h('span', { class: 'header__actions' },
    action('window', 'Open session in a tab', () => post({ type: 'open', where: 'tab' })),
    action('layout-sidebar-right', 'Open session in the right panel', () => post({ type: 'open', where: 'right' })),
    action('file-code', 'Raw transcript of the selected node', () => post({ type: 'raw', nodeId: selected })),
    action('refresh', 'Re-read from disk', () => post({ type: 'refresh' }))));
  return el;
}

function renderTimeline(): HTMLElement {
  const g = graph!; const now = hostNow();
  // a clock label is ~55px of 10px mono; below ~130px per interval the labels run into each other
  const layout = layoutTimeline(bars(g), now, Math.max(1, Math.min(5, Math.floor((root.clientWidth || 800) / 130))));
  const H = 16, GAP = 4, TOP = 16, BOTTOM = 2;
  const height = TOP + layout.lanes * (H + GAP) + BOTTOM;
  const el = svg('svg', { class: 'timeline__svg', height, role: 'img', 'aria-label': 'Agent timeline' });
  layout.ticks.forEach((t, i) => {
    const x = `${(t.x * 100).toFixed(3)}%`;
    el.append(svg('line', { x1: x, x2: x, y1: TOP - 3, y2: height, class: 'timeline__tick' }));
    const label = svg('text', { x, y: 10, class: 'timeline__label', 'text-anchor': i === layout.ticks.length - 1 ? 'end' : i === 0 ? 'start' : 'middle' });
    label.textContent = t.label; el.append(label);
  });
  for (const p of layout.placed) {
    const y = TOP + p.lane * (H + GAP);
    const cls = `bar bar--${p.bar.status} bar--${p.bar.kind}${p.bar.id === selected ? ' bar--selected' : ''}`;
    const name = p.bar.tag ? `${p.bar.label} · ${p.bar.tag}` : p.bar.label;
    const gEl = svg('g', { class: cls, 'data-id': p.bar.id });
    gEl.append(svg('rect', { x: `${(p.x0 * 100).toFixed(3)}%`, y, width: `${((p.x1 - p.x0) * 100).toFixed(3)}%`, height: H }));
    if (p.x1 - p.x0 > 0.08) {
      const text = svg('text', { x: `${(p.x0 * 100).toFixed(3)}%`, y: y + 12, dx: 5, class: 'bar__label' });
      text.textContent = name; gEl.append(text);
    }
    const tip = svg('title');
    tip.textContent = `${name} · ${p.bar.status} · ${fmtClock(p.bar.start)}${p.bar.end ? ` – ${fmtClock(p.bar.end)} (${fmtDuration(p.bar.end - p.bar.start)})` : ' → now'}`;
    gEl.append(tip);
    gEl.addEventListener('click', () => select(p.bar.id));
    el.append(gEl);
  }
  if (live) el.append(svg('line', { x1: '100%', x2: '100%', y1: TOP - 3, y2: height, class: 'timeline__now' }));
  return h('section', { class: 'timeline' }, el);
}

function renderTree(): HTMLElement {
  const g = graph!;
  const nav = h('nav', { class: 'tree', role: 'listbox', 'aria-label': 'Agents' });
  for (const r of treeRows(g, hostNow(), reducedMotion)) {
    const row = h('button', { class: 'tree__row', role: 'option', 'aria-selected': String(r.id === selected), 'data-status': r.status, 'data-kind': r.kind,
                              style: `--depth: ${r.depth}`, title: r.tag ? `${r.label} · ${r.tag}` : r.label },
      h('i', { class: `tree__icon ${iconClasses(r.icon)}`, 'aria-hidden': 'true' }),
      h('span', { class: 'tree__label' }, h('span', { class: 'tree__text' }, r.label), ...(r.tag ? [h('span', { class: 'tree__tag' }, r.tag)] : [])),
      h('span', { class: 'tree__meta' }, r.meta));
    row.addEventListener('click', () => select(r.id));
    nav.append(row);
  }
  return nav;
}

// ---------------------------------------------------------------- reader

function renderText(text: string, cls: string): HTMLElement {
  const el = h('div', { class: cls });
  text.split('```').forEach((part, i) => {
    if (i % 2 === 1) el.append(h('pre', { class: 'code' }, part.replace(/^[a-z0-9_-]*\n/i, '')));
    else if (part.trim()) el.append(h('p', {}, part.trim()));
  });
  return el;
}

function formatInput(c: ToolCall): string {
  if (c.name === 'Bash' && typeof c.input.command === 'string') return c.input.command;
  const inp: Record<string, unknown> = { ...c.input };
  for (const k of ['content', 'new_string', 'old_string', 'prompt', 'script']) {
    const v = inp[k];
    if (typeof v === 'string' && v.length > 2000) inp[k] = `${v.slice(0, 2000)}… (${v.length - 2000} more)`;
  }
  return JSON.stringify(inp, null, 2);
}

function renderTool(c: ToolCall): HTMLElement {
  const d = document.createElement('details');
  d.className = `tool${c.result?.isError ? ' tool--error' : ''}${c.result ? '' : ' tool--pending'}`;
  const meta = [c.result ? fmtDuration(c.result.ts - c.ts) : 'running', c.result?.isError ? 'error' : undefined,
                c.result?.images ? `${c.result.images} image${c.result.images > 1 ? 's' : ''}` : undefined].filter((x): x is string => !!x).join(' · ');
  const sum = h('summary', { class: 'tool__summary' },
    h('i', { class: `codicon codicon-${toolIcon(c.name)}`, 'aria-hidden': 'true' }),
    h('span', { class: 'tool__name' }, c.name),
    h('span', { class: 'tool__what' }, c.summary),
    h('span', { class: 'tool__meta' }, meta));
  const target = c.agentId && graph ? Object.values(graph.nodes).find(n => n.agentId === c.agentId) : undefined;
  if (target) {
    const link = h('button', { class: 'tool__link' }, 'open agent →');
    link.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); select(target.id); });
    sum.append(link);
  }
  d.append(sum);
  const body = h('div', { class: 'tool__body' }, h('pre', { class: 'tool__input' }, formatInput(c)));
  if (c.result) body.append(h('pre', { class: 'tool__output' }, c.result.text + (c.result.truncated ? `\n… ${c.result.truncated} more characters — see the raw transcript` : '')));
  d.append(body);
  return d;
}

function renderItem(it: Item): HTMLElement {
  switch (it.kind) {
    case 'text': return renderText(it.text, 'item item--text');
    case 'thinking': return h('div', { class: 'item item--thinking' }, h('i', { class: 'codicon codicon-lightbulb', 'aria-hidden': 'true' }), 'thought (redacted in the transcript)');
    case 'image': return h('div', { class: 'item item--image' }, h('img', { src: it.dataUrl, alt: 'image from the prompt', loading: 'lazy' }));
    case 'tool': return renderTool(it.call);
    case 'context': {
      const d = document.createElement('details'); d.className = 'item item--context';
      const head = it.text.replace(/^<[a-z-]+>\s*/i, '').split('\n')[0] ?? '';
      d.append(h('summary', {}, h('i', { class: 'codicon codicon-info', 'aria-hidden': 'true' }), `context · ${head.slice(0, 80)}${head.length > 80 ? '…' : ''} · ${fmtTokens(it.text.length)} chars`),
               h('pre', { class: 'code' }, it.text.length > 6000 ? `${it.text.slice(0, 6000)}\n… ${it.text.length - 6000} more characters — see the raw transcript` : it.text));
      return d;
    }
  }
}

function renderTurn(t: Turn): HTMLElement {
  const art = h('article', { class: `turn turn--${t.promptKind}`, 'data-turn': String(t.index) });
  const dur = t.durationMs ?? (t.endTs > t.startTs ? t.endTs - t.startTs : 0);
  const meta = [fmtClock(t.startTs), dur ? fmtDuration(dur) : undefined, t.outputTokens ? `${fmtTokens(t.outputTokens)} out` : undefined,
                t.promptImages ? `${t.promptImages} image${t.promptImages > 1 ? 's' : ''}` : undefined].filter((x): x is string => !!x).join(' · ');
  const who = t.promptKind === 'notification' ? 'background agent' : t.promptKind === 'meta' ? 'context' : t.promptKind === 'command' ? 'command' : 'you';
  const prompt = t.prompt || (t.promptKind === 'meta' ? '' : '(no text)');    // a context-only turn has nothing to quote
  art.append(h('div', { class: 'turn__prompt' }, h('span', { class: 'turn__who' }, who), renderText(prompt, 'turn__prompt-text'), h('span', { class: 'turn__meta' }, meta)));
  for (const it of t.items) art.append(renderItem(it));
  return art;
}

function renderReader(): HTMLElement {
  const sec = h('section', { class: 'reader', 'aria-label': 'Transcript' });
  if (!page) { sec.append(h('div', { class: 'empty' }, 'Loading…')); return sec; }
  const node: GraphNode | undefined = graph?.nodes[page.nodeId];
  sec.append(h('div', { class: 'reader__head' },
    h('span', { class: 'reader__title' }, node?.label ?? page.nodeId),
    h('span', { class: 'reader__meta' }, `${page.total} ${page.total === 1 ? 'turn' : 'turns'}${node?.model ? ` · ${node.model.replace(/^claude-/, '')}` : ''}${node?.file ? '' : ' · no transcript on disk'}`)));
  if (page.from > 0) {
    const more = h('button', { class: 'reader__more' }, `Show earlier turns (${page.from} more)`);
    more.addEventListener('click', () => post({ type: 'more', nodeId: page!.nodeId, from: Math.max(0, page!.from - 40) }));
    sec.append(more);
  }
  const list = h('div', { class: 'turns' });
  if (page.turns.length === 0) list.append(h('div', { class: 'empty' }, node?.file ? 'Nothing conversational in this transcript yet.' : 'This node has no transcript file — a denied spawn, or a workflow shell.'));
  for (const t of page.turns) list.append(renderTurn(t));
  sec.append(list);
  return sec;
}

// ---------------------------------------------------------------- composition

/** Swap in a fresh tree without losing where the user had scrolled it — this runs every second while live. */
function replaceTree(old: Element | null, next: HTMLElement): void {
  const top = old?.scrollTop ?? 0;
  if (old) old.replaceWith(next); else root.append(next);
  next.scrollTop = top;
}

function renderTop(): void {
  if (!graph) return;
  const [header, timeline, tree] = [root.querySelector('.header'), root.querySelector('.timeline'), root.querySelector('.tree')];
  header?.replaceWith(renderHeader()); timeline?.replaceWith(renderTimeline());
  replaceTree(tree, renderTree());
}

function render(): void {
  if (!graph) return;
  const oldReader = root.querySelector<HTMLElement>('.reader');
  const stickToBottom = oldReader ? oldReader.scrollHeight - oldReader.scrollTop - oldReader.clientHeight < 40 : true;
  const scrollTop = oldReader?.scrollTop ?? 0;
  const treeTop = root.querySelector('.tree')?.scrollTop ?? 0;
  const reader = renderReader();
  const tree = renderTree();
  root.replaceChildren(renderHeader(), renderTimeline(), tree, reader);
  tree.scrollTop = treeTop;
  reader.scrollTop = live && stickToBottom ? reader.scrollHeight : scrollTop;
}

window.addEventListener('message', (e: MessageEvent<Inbound>) => {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'error') { root.replaceChildren(h('div', { class: 'empty' }, m.message)); return; }
  clockOffset = m.now - Date.now();
  if (m.type === 'init' || m.type === 'update') {
    graph = m.graph; title = m.title; live = m.live;
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
setInterval(() => { if (live) renderTop(); }, 1_000);               // running durations keep ticking
post({ type: 'ready' });
