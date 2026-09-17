/// <reference lib="dom" />
// The sidebar browser's DOM glue. Everything with logic is in model.ts (tested); this file only
// turns a ViewModel into elements and user gestures into messages (spec §9.1).
import { viewModel, timeLabel, type ViewModel, type RowVM, type LinkVM } from './model.js';
import type { Snapshot } from '../core/rows.js';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};
const api = acquireVsCodeApi();

interface Inbound { type: 'snapshot'; snapshot: Snapshot; now: number; activeWindow: string }
interface UiState { collapsed: Record<string, boolean> }

let snapshot: Snapshot | null = null;
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

function rowEl(r: RowVM | LinkVM): HTMLLIElement {
  if (r.kind === 'link') {
    const li = h('li', { class: 'row row--link', role: 'option', tabindex: '-1', 'data-action': r.action },
      h('i', { class: `row__icon ${r.iconClass}`, 'aria-hidden': 'true' }),
      h('span', { class: 'row__title' }, r.title),
      h('span', { class: 'row__time' }, r.meta));
    li.addEventListener('click', () => post({ type: 'search' }));
    return li;
  }
  const li = h('li', { class: 'row', role: 'option', tabindex: '-1', 'data-state': r.state, 'data-id': r.sessionId, title: r.title });
  if (r.reason) li.dataset.reason = r.reason;
  const actions = h('span', { class: 'row__actions' },
    actionButton('window', 'Open in tab', () => post({ type: 'open', sessionId: r.sessionId, where: 'tab' })),
    actionButton('layout-sidebar-right', 'Open in right panel', () => post({ type: 'open', sessionId: r.sessionId, where: 'right' })),
    actionButton('link', 'Copy deep link', () => post({ type: 'copyLink', sessionId: r.sessionId })),
    actionButton('folder', 'Reveal folder', () => post({ type: 'reveal', sessionId: r.sessionId })),
    actionButton('file-code', 'Open transcript', () => post({ type: 'transcript', sessionId: r.sessionId })),
  );
  const meta = h('span', { class: 'row__meta' }, r.meta);
  if (r.missing) meta.append(h('span', { class: 'row__missing' }, '⚠ folder missing'));
  li.append(
    h('i', { class: `row__icon ${r.iconClass}`, 'aria-hidden': 'true' }),
    h('span', { class: 'row__title' }, r.title),
    h('span', { class: 'row__time' }, r.time),
    actions,
    meta,
  );
  li.addEventListener('click', () => post({ type: 'open', sessionId: r.sessionId, where: 'tab' }));
  return li;
}

function sectionEl(s: ViewModel['sections'][number]): HTMLElement {
  const collapsed = ui.collapsed[s.id] === true;
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
  const vm = viewModel(snapshot, hostNow(), { activeWindowLabel: activeWindow, searchKey, reducedMotion });
  root.replaceChildren(...vm.sections.map(sectionEl));
  if (focusedId) root.querySelector<HTMLElement>(`[data-id="${focusedId}"]`)?.focus();
}

/** Between snapshots only the relative-time labels change (spec §8) — update those, not the tree. */
function refreshTimes(): void {
  if (!snapshot) return;
  const now = hostNow();
  for (const r of snapshot.active) {
    const el = root.querySelector<HTMLElement>(`.row[data-id="${r.sessionId}"] .row__time`);
    if (el) el.textContent = timeLabel(r, now);
  }
}

/** Roving focus: ↑/↓ move, Enter opens in a tab, Shift+Enter in the right panel, T transcript, / search. */
root.addEventListener('keydown', e => {
  const rows = Array.from(root.querySelectorAll<HTMLElement>('.row'));   // not [...], which needs lib dom.iterable
  const current = document.activeElement as HTMLElement | null;
  const i = current ? rows.indexOf(current) : -1;
  const focus = (j: number) => rows[Math.max(0, Math.min(rows.length - 1, j))]?.focus();
  const id = current?.dataset.id;
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); focus(i + 1); break;
    case 'ArrowUp':   e.preventDefault(); focus(i - 1); break;
    case 'Home':      e.preventDefault(); focus(0); break;
    case 'End':       e.preventDefault(); focus(rows.length - 1); break;
    case 'Enter':
      e.preventDefault();
      if (id) post({ type: 'open', sessionId: id, where: e.shiftKey ? 'right' : 'tab' });
      else if (current?.dataset.action === 'search') post({ type: 'search' });
      break;
    case 't': case 'T': if (id) post({ type: 'transcript', sessionId: id }); break;
    case '/': e.preventDefault(); post({ type: 'search' }); break;
    case 'Escape': current?.blur(); break;
  }
});
// Tab lands on <main>; hand focus to the first row so the roving list takes over.
root.addEventListener('focus', () => root.querySelector<HTMLElement>('.row')?.focus());

window.addEventListener('message', (e: MessageEvent<Inbound>) => {
  const m = e.data;
  if (!m || m.type !== 'snapshot') return;
  snapshot = m.snapshot;
  activeWindow = m.activeWindow;
  clockOffset = m.now - Date.now();
  render();
});
setInterval(refreshTimes, 1_000);
post({ type: 'ready' });
