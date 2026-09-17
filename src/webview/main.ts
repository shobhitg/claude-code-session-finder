/// <reference lib="dom" />
// The sidebar browser's DOM glue. Everything with logic is in model.ts (tested); this file only
// turns a ViewModel into elements and user gestures into messages (spec §9.1).
import { viewModel, resultsModel, timeLabel, type ViewModel, type RowVM, type LinkVM } from './model.js';
import type { Snapshot, SearchRow } from '../core/rows.js';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};
const api = acquireVsCodeApi();

type Inbound =
  | { type: 'snapshot'; snapshot: Snapshot; now: number; activeWindow: string; active: string | null }
  | { type: 'results'; q: string; deep: boolean; rows: SearchRow[]; now: number; indexing: boolean }
  | { type: 'active'; sessionId: string | null }
  | { type: 'focusFilter'; q?: string };
interface UiState { collapsed: Record<string, boolean>; filter?: string }

let snapshot: Snapshot | null = null;
let results: { q: string; deep: boolean; rows: SearchRow[] } | null = null;
let activeId: string | null = null;
let scrolledTo: string | null = null;       // the selected row we last scrolled into view
let clockOffset = 0;                       // host clock − webview clock; labels use the host's clock
let activeWindow = '4h';
const ui: UiState = (api.getState() as UiState | undefined) ?? { collapsed: {} };
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const searchKey = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘⌥S' : 'Ctrl+Alt+S';
const root = document.getElementById('app') as HTMLElement;

const post = (message: unknown): void => api.postMessage(message);

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string> = {}, ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) el.append(c);
  return el;
}

function actionButton(icon: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = h('button', { class: 'action', title: label, 'aria-label': label },
    h('i', { class: `codicon codicon-${icon}`, 'aria-hidden': 'true' }));
  b.addEventListener('click', e => { e.stopPropagation(); onClick(); });
  return b;
}

// ---------------------------------------------------------------- the filter bar (built once: it holds focus and caret)

const filterInput = h('input', {
  class: 'filter__input', type: 'text', spellcheck: 'false', 'aria-label': 'Filter sessions',
  placeholder: 'Filter sessions — words, "phrase", pr:123, since:all',
});
const filterBar = h('div', { class: 'filter' },
  h('i', { class: 'filter__icon codicon codicon-search', 'aria-hidden': 'true' }),
  filterInput,
  actionButton('close', 'Clear filter', () => setFilter('')));
const sectionsEl = h('div', { class: 'sections' });
root.append(filterBar, sectionsEl);

const filtering = (): boolean => (ui.filter ?? '').trim().length > 0;
const firstRow = (): HTMLElement | null => sectionsEl.querySelector<HTMLElement>('.row');
let filterTimer: number | undefined;

/** The filter runs the host's search (debounced) and swaps the list for RESULTS; empty text restores the list. */
function setFilter(q: string, fromInput = false): void {
  ui.filter = q; api.setState(ui);
  if (!fromInput) filterInput.value = q;
  filterBar.dataset.active = String(q.trim().length > 0);
  window.clearTimeout(filterTimer);
  if (!q.trim()) { results = null; render(); return; }
  if (results?.q !== q) { results = null; render(); }         // skeleton until the host answers
  filterTimer = window.setTimeout(() => post({ type: 'filter', q }), 120);
}
filterInput.value = ui.filter ?? '';
filterBar.dataset.active = String(filtering());
filterInput.addEventListener('input', () => setFilter(filterInput.value, true));
filterInput.addEventListener('keydown', e => {
  e.stopPropagation();                                          // the list's roving-focus handler must not see these
  if (e.key === 'Escape') { e.preventDefault(); if (filterInput.value) setFilter(''); else firstRow()?.focus(); }
  else if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); firstRow()?.focus(); }
});
const focusFilter = (): void => { filterInput.focus(); filterInput.select(); };
const linkAction = (a: LinkVM['action']): void => { if (a === 'search') focusFilter(); else post({ type: 'toggleScope' }); };

// ---------------------------------------------------------------- rows and sections

function rowEl(r: RowVM | LinkVM): HTMLLIElement {
  if (r.kind === 'link') {
    const li = h('li', { class: 'row row--link', role: 'option', tabindex: '-1', 'data-action': r.action },
      h('i', { class: `row__icon ${r.iconClass}`, 'aria-hidden': 'true' }),
      h('span', { class: 'row__title' }, r.title),
      h('span', { class: 'row__time' }, r.meta));
    li.addEventListener('click', () => linkAction(r.action));
    return li;
  }
  const li = h('li', { class: `row${r.snippet ? ' row--snippet' : ''}`, role: 'option', tabindex: '-1',
                       'data-state': r.state, 'data-id': r.sessionId, title: `${r.title} — ${r.stateLabel}`, 'aria-selected': String(r.selected) });
  if (r.reason) li.dataset.reason = r.reason;
  const actions = h('span', { class: 'row__actions' },
    actionButton('type-hierarchy', 'Open session view', () => post({ type: 'view', sessionId: r.sessionId })),
    actionButton('window', 'Open in tab', () => post({ type: 'open', sessionId: r.sessionId, where: 'tab' })),
    actionButton('layout-sidebar-right', 'Open in right panel', () => post({ type: 'open', sessionId: r.sessionId, where: 'right' })),
    actionButton('link', 'Copy deep link', () => post({ type: 'copyLink', sessionId: r.sessionId })),
    actionButton('folder', 'Reveal folder', () => post({ type: 'reveal', sessionId: r.sessionId })),
    actionButton('file-code', 'Open transcript', () => post({ type: 'transcript', sessionId: r.sessionId })),
  );
  const meta = h('span', { class: 'row__meta' }, r.meta);
  if (r.missing) meta.append(h('span', { class: 'row__missing' }, '⚠ folder missing'));
  li.append(
    h('i', { class: `row__icon ${r.iconClass}`, title: r.stateLabel, 'aria-label': r.stateLabel, role: 'img' }),
    h('span', { class: 'row__title' }, r.title),
    h('span', { class: 'row__time' }, r.time),
    actions,
    meta,
  );
  if (r.snippet) li.append(h('span', { class: 'row__snippet' }, r.snippet));
  li.addEventListener('click', () => post({ type: 'open', sessionId: r.sessionId, where: 'tab' }));
  return li;
}

function sectionEl(s: ViewModel['sections'][number]): HTMLElement {
  const collapsed = s.id !== 'results' && ui.collapsed[s.id] === true;
  const header = h('button', { class: 'section__header', 'aria-expanded': String(!collapsed) },
    h('i', { class: 'section__chevron codicon codicon-chevron-down', 'aria-hidden': 'true' }),
    h('span', {}, s.label),
    h('span', { class: 'section__count' }, String(s.count)));
  header.addEventListener('click', () => { ui.collapsed[s.id] = !collapsed; api.setState(ui); render(); });
  const body = h('div', { class: 'section__body' });
  if (s.skeleton) {
    for (let i = 0; i < 3; i++) {
      body.append(h('div', { class: 'skeleton' }, h('span', {}),
        h('span', { class: `skeleton__bar${i % 2 ? ' skeleton__bar--short' : ''}` })));
    }
  } else if (s.empty) {
    body.append(h('div', { class: 'empty' }, s.empty));
  } else {
    const ul = h('ul', { class: 'list', role: 'listbox', 'aria-label': s.label });
    for (const r of s.rows) ul.append(rowEl(r));
    body.append(ul);
  }
  return h('section', { class: 'section', 'data-collapsed': String(collapsed) }, header, body);
}

const hostNow = (): number => Date.now() + clockOffset;

function render(): void {
  if (!snapshot) return;
  const focusedId = (document.activeElement as HTMLElement | null)?.dataset.id;
  const opts = { activeWindowLabel: activeWindow, searchKey, reducedMotion, activeId };
  const q = ui.filter ?? '';
  const vm = filtering()
    ? resultsModel(results && results.q === q ? results.rows : null, q, results?.deep ?? false, hostNow(), opts)
    : viewModel(snapshot, hostNow(), opts);
  sectionsEl.replaceChildren(...vm.sections.map(sectionEl));
  if (focusedId) sectionsEl.querySelector<HTMLElement>(`[data-id="${focusedId}"]`)?.focus();
  // Follow the active tab into view once per change — not on every snapshot, which would fight the user's scrolling.
  if (activeId && activeId !== scrolledTo) {
    const sel = sectionsEl.querySelector<HTMLElement>(`.row[aria-selected="true"]`);
    if (sel) { sel.scrollIntoView({ block: 'nearest' }); scrolledTo = activeId; }
  }
}

/** Between snapshots only the relative-time labels change (spec §8) — update those, not the tree. */
function refreshTimes(): void {
  if (!snapshot) return;
  const now = hostNow();
  const rows = filtering() ? (results?.rows ?? []).flatMap(r => r.live ? [{ sessionId: r.sessionId, ...r.live }] : []) : snapshot.active;
  for (const r of rows) {
    const el = sectionsEl.querySelector<HTMLElement>(`.row[data-id="${r.sessionId}"] .row__time`);
    if (el) el.textContent = timeLabel(r, now);
  }
}

/** Roving focus: ↑/↓ move, Enter opens in a tab, Shift+Enter in the right panel, T transcript, V view, / filter. */
root.addEventListener('keydown', e => {
  const rows = Array.from(sectionsEl.querySelectorAll<HTMLElement>('.row'));   // not [...], which needs lib dom.iterable
  const current = document.activeElement as HTMLElement | null;
  const i = current ? rows.indexOf(current) : -1;
  const focus = (j: number) => rows[Math.max(0, Math.min(rows.length - 1, j))]?.focus();
  const id = current?.dataset.id;
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); focus(i + 1); break;
    case 'ArrowUp':   e.preventDefault(); if (i <= 0) focusFilter(); else focus(i - 1); break;
    case 'Home':      e.preventDefault(); focus(0); break;
    case 'End':       e.preventDefault(); focus(rows.length - 1); break;
    case 'Enter':
      e.preventDefault();
      if (id) post({ type: 'open', sessionId: id, where: e.shiftKey ? 'right' : 'tab' });
      else if (current?.dataset.action) linkAction(current.dataset.action as LinkVM['action']);
      break;
    case 't': case 'T': if (id) post({ type: 'transcript', sessionId: id }); break;
    case 'v': case 'V': if (id) post({ type: 'view', sessionId: id }); break;
    case '/': e.preventDefault(); focusFilter(); break;
    case 'Escape': if (filtering()) setFilter(''); else current?.blur(); break;
  }
});
// Tab lands on <main>; hand focus to the first row so the roving list takes over.
root.addEventListener('focus', () => firstRow()?.focus());

window.addEventListener('message', (e: MessageEvent<Inbound>) => {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  switch (m.type) {
    case 'snapshot':
      snapshot = m.snapshot; activeWindow = m.activeWindow; clockOffset = m.now - Date.now(); activeId = m.active;
      render();
      if (filtering()) post({ type: 'filter', q: ui.filter ?? '' });   // the index moved; re-ask so results stay current
      return;
    case 'results':
      if (m.q !== (ui.filter ?? '')) return;                           // a stale answer for text we left behind
      results = { q: m.q, deep: m.deep, rows: m.rows }; clockOffset = m.now - Date.now();
      render();
      return;
    case 'active':
      if (m.sessionId === activeId) return;
      activeId = m.sessionId; render();
      return;
    case 'focusFilter':
      if (typeof m.q === 'string') setFilter(m.q);
      focusFilter();
      return;
  }
});
setInterval(refreshTimes, 1_000);
post({ type: 'ready' });
