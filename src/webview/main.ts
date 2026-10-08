/// <reference lib="dom" />
// The sidebar browser's DOM glue. Everything with logic is in model.ts (tested); this file only
// turns a ViewModel into elements and user gestures into messages (spec §9.1).
//
// Rendering is a keyed reconciliation, not a rebuild: a snapshot arrives every two seconds while
// anything is running, and rebuilding the list on each one replayed every row's fade-in and dropped
// the hover state under the pointer — the list flickered. Rows are keyed by session id and updated
// in place; only a row that is new fades in; a row that changes position slides (FLIP); and while
// the pointer is over the list the order is held until it leaves.
import { viewModel, resultsModel, timeLabel, timeTip, ageTag, moreLabel, activeReserve, type ViewModel, type ViewOpts, type SectionVM, type RowVM, type LinkVM, type AgeTag, type ChipVM, type WhereVM } from './model.js';
import type { Snapshot, SearchRow } from '../core/rows.js';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};
const api = acquireVsCodeApi();

type Inbound =
  | { type: 'snapshot'; snapshot: Snapshot; now: number; activeWindow: string; activeWindowMs: number; contextBudget: number; active: string | null }
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
let activeWindowMs = 4 * 3_600_000;
let contextBudget = 1_000_000;
let orderPending = false;                  // a reorder arrived while the pointer was over the list
const ui: UiState = (api.getState() as UiState | undefined) ?? { collapsed: {} };
for (const k of ['seen', 'seenN', 'arrivals']) delete (ui as unknown as Record<string, unknown>)[k];   // the order the webview kept until 0.9.0; the host's order is stable now (D14)
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

/** Tooltips are our own (`.tip[data-tip]`, style.css): native `title` bubbles are slow and easy to miss in a webview. */
function actionButton(icon: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = h('button', { class: 'action tip', 'data-tip': label, 'aria-label': label },
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
  if (!q.trim()) { results = null; render(true); return; }
  if (results?.q !== q) { results = null; render(true); }     // skeleton until the host answers
  filterTimer = window.setTimeout(() => post({ type: 'filter', q }), 120);
}
filterInput.value = ui.filter ?? '';
filterBar.dataset.active = String(filtering());
filterInput.addEventListener('input', () => setFilter(filterInput.value, true));
// No stopPropagation here: VS Code's webview host listens on the window and performs Cmd+V, Cmd+A, Cmd+Z…
// for a webview, so a keydown that never reaches it does nothing. The list's handler skips the filter's keys.
filterInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); if (filterInput.value) setFilter(''); else firstRow()?.focus(); }
  else if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); firstRow()?.focus(); }
});
const focusFilter = (): void => { filterInput.focus(); filterInput.select(); };
const linkAction = (a: LinkVM['action']): void => {
  if (a === 'search') focusFilter(); else post({ type: a === 'headless' ? 'toggleHeadless' : 'toggleScope' });
};

// ---------------------------------------------------------------- rows

const keyOf = (r: RowVM | LinkVM): string => r.kind === 'link' ? `link:${r.action}` : r.sessionId;

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
/** D15: the headless glyph — a ghost (it runs with nobody there) with a spark for an eye. Drawn for this view; currentColor. */
function ghostSvg(): SVGElement {
  const svg = svgEl('svg', { class: 'ghost__svg', viewBox: '0 0 16 16', 'aria-hidden': 'true' });
  svg.append(
    svgEl('path', { d: 'M3 14.4V7.6A5 5 0 0 1 13 7.6V14.4L11.35 13.1L9.7 14.4L8 13.1L6.3 14.4L4.65 13.1Z', fill: 'none', stroke: 'currentColor',
                    'stroke-width': '1.25', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
    svgEl('circle', { cx: '6.2', cy: '7.7', r: '.95', fill: 'currentColor' }),
    svgEl('path', { class: 'ghost__spark', fill: 'currentColor', d: 'M9.9 6.2Q10.2 7.4 11.4 7.7Q10.2 8 9.9 9.2Q9.6 8 8.4 7.7Q9.6 7.4 9.9 6.2Z' }));
  return svg;
}
/** Put the ghost and its dot in a row's icon slot — or take them out. The slot is never rebuilt otherwise. */
function setGhost(icon: HTMLElement, ghost: RowVM['ghost'] | 'link'): void {
  if (!ghost) { if (icon.firstChild) icon.replaceChildren(); return; }
  if (!icon.querySelector('.ghost__svg')) icon.replaceChildren(ghostSvg(), ...(ghost === 'link' ? [] : [h('span', { class: 'ghost__dot' })]));
  const dot = icon.querySelector<HTMLElement>('.ghost__dot');
  if (dot && ghost !== 'link' && dot.dataset.ghost !== ghost) dot.dataset.ghost = ghost;
}

/** Bring an existing row's attributes and text in line with its model. Structure never changes, so no rebuild. */
function updateRow(li: HTMLLIElement, r: RowVM | LinkVM): void {
  const text = (sel: string, value: string): void => {
    const el = li.querySelector<HTMLElement>(sel);
    if (el && el.textContent !== value) el.textContent = value;
  };
  if (r.kind === 'link') {
    text('.row__title', r.title); text('.row__time', r.meta);
    const icon = li.querySelector<HTMLElement>('.row__icon')!;
    icon.className = `row__icon ${r.iconClass}`; setGhost(icon, r.ghost ? 'link' : undefined);
    return;
  }
  li.className = `row${r.snippet ? ' row--snippet' : ''}`;
  li.dataset.state = r.state;
  if (r.reason) li.dataset.reason = r.reason; else delete li.dataset.reason;
  if (r.ringing) li.dataset.ringing = 'true'; else delete li.dataset.ringing;
  if (r.ghost) li.dataset.ghost = r.ghost; else delete li.dataset.ghost;
  if (r.tone) li.dataset.tone = r.tone; else delete li.dataset.tone;
  if (r.selected) li.setAttribute('aria-current', 'true'); else li.removeAttribute('aria-current');
  li.querySelector<HTMLElement>('.action--close')!.hidden = r.state === 'history';   // nothing to close on a closed row
  // The right-click menu (package.json, webview/context): VS Code reads this, offers the row's commands and passes it to them.
  const menu = JSON.stringify({ webviewSection: 'session', sessionId: r.sessionId, closed: r.state === 'history', headless: !!r.ghost, preventDefaultContextMenuItems: true });
  if (li.dataset.vscodeContext !== menu) li.dataset.vscodeContext = menu;
  const icon = li.querySelector<HTMLElement>('.row__icon')!;
  // a ghost row draws its own glyph: the state's codicon would paint over it
  icon.className = `row__icon tip tip--left${r.ghost ? '' : ` ${r.iconClass}`}`; icon.dataset.tip = r.stateLabel; icon.setAttribute('aria-label', r.stateLabel);
  setGhost(icon, r.ghost);
  // a new title may now fit, or not: fit() decides whether it names itself in a tooltip
  const titleEl = li.querySelector<HTMLElement>('.row__title')!;
  if (titleEl.textContent !== r.title) { titleEl.textContent = r.title; fitted.delete(li); fitSoon(); }
  setTime(li.querySelector<HTMLElement>('.row__time')!, r.age ? '' : r.time, r.timeTip);   // the age tag stands in for the time
  const where = JSON.stringify([r.where, r.links, r.missing]);
  if (drawn.get(li) !== where) { drawn.set(li, where); drawWhere(li, r); fitted.delete(li); fitSoon(); }
  // the age tag and the meter share line 2 with the links: a change of their width is a refit
  const beside = `${r.age?.label ?? ''}|${r.heat?.label ?? ''}`;
  if (besideLinks.get(li) !== beside) { besideLinks.set(li, beside); fitted.delete(li); fitSoon(); }
  const heat = li.querySelector<HTMLElement>('.row__heat')!;
  if (r.heat) {
    li.dataset.heat = r.heat.tier;
    if (!heat.firstChild) heat.append(h('span', { class: 'heat__track' }, h('span', { class: 'heat__fill' })), h('span', { class: 'heat__label' }));
    heat.dataset.tip = r.heat.title; heat.setAttribute('aria-label', r.heat.title);
    heat.querySelector<HTMLElement>('.heat__fill')!.style.transform = `scaleX(${r.heat.pct / 100})`;
    const label = heat.querySelector<HTMLElement>('.heat__label')!;
    if (label.textContent !== r.heat.label) label.textContent = r.heat.label;
  } else if (heat.firstChild) { heat.replaceChildren(); delete heat.dataset.tip; heat.removeAttribute('aria-label'); delete li.dataset.heat; }
  setAge(li.querySelector<HTMLElement>('.row__age')!, r.age);
  const snippet = li.querySelector<HTMLElement>('.row__snippet');
  if (r.snippet && !snippet) li.querySelector('.row__lines')!.append(h('span', { class: 'row__snippet' }, r.snippet));
  else if (r.snippet && snippet) { if (snippet.textContent !== r.snippet) snippet.textContent = r.snippet; }
  else snippet?.remove();
}

// ---------------------------------------------------------------- line 2 and the links

/** What each row's line 2 and links were last drawn from — redrawn only when that changes, not every snapshot. */
const drawn = new WeakMap<HTMLElement, string>();
const besideLinks = new WeakMap<HTMLElement, string>();

function whereItem(cls: string, icon: string, part: { label: string; tip: string }): HTMLElement {
  return h('span', { class: `where__item ${cls} tip tip--left`, 'data-tip': part.tip },
    h('i', { class: `codicon codicon-${icon}`, 'aria-hidden': 'true' }), h('span', { class: 'where__txt' }, part.label));
}

const SVG = 'http://www.w3.org/2000/svg';
/**
 * Slack's own mark, in its own colours: a link is recognised by its logo, and the theme's muted grey made it
 * hard to see. A logo is an image, not a colour of this view, so its fills live here and not in the stylesheet
 * (which has no colour of its own); high-contrast themes draw it in the text colour (style.css).
 */
const SLACK_MARK: Array<[string, string]> = [
  ['#E01E5A', 'M27.2 80c0 7.3-5.9 13.2-13.2 13.2C6.7 93.2.8 87.3.8 80c0-7.3 5.9-13.2 13.2-13.2h13.2V80zm6.6 0c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2v33c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V80z'],
  ['#36C5F0', 'M47 27c-7.3 0-13.2-5.9-13.2-13.2C33.8 6.5 39.7.6 47 .6c7.3 0 13.2 5.9 13.2 13.2V27H47zm0 6.7c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H13.9C6.6 60.1.7 54.2.7 46.9c0-7.3 5.9-13.2 13.2-13.2H47z'],
  ['#2EB67D', 'M99.9 46.9c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H99.9V46.9zm-6.6 0c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V13.8C66.9 6.5 72.8.6 80.1.6c7.3 0 13.2 5.9 13.2 13.2v33.1z'],
  ['#ECB22E', 'M80.1 99.8c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V99.8h13.2zm0-6.6c-7.3 0-13.2-5.9-13.2-13.2 0-7.3 5.9-13.2 13.2-13.2h33.1c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H80.1z'],
];
function slackMark(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'slack-mark'); svg.setAttribute('viewBox', '0 0 127 127'); svg.setAttribute('aria-hidden', 'true');
  for (const [fill, d] of SLACK_MARK) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('fill', fill); path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

const chipIcon = (c: ChipVM): Element => c.icon === 'slack' ? slackMark() : h('i', { class: `codicon codicon-${c.icon}`, 'aria-hidden': 'true' });

function openLink(sessionId: string, url: string): void { post({ type: 'openLink', sessionId, url }); }

function chipEl(sessionId: string, c: ChipVM): HTMLButtonElement {
  const b = h('button', { class: `link link--${c.kind} tip tip--left`, 'data-tip': c.tip, 'aria-label': c.aria, ...(c.state ? { 'data-state': c.state } : {}) },
    chipIcon(c), ...(c.label ? [h('span', { class: 'link__num' }, c.label)] : []));
  b.addEventListener('click', e => { e.stopPropagation(); openLink(sessionId, c.url); });
  return b;
}

/** Line 2 (project, branch, worktree) and the links, drawn from the model; fit() then decides which line the links take. */
function drawWhere(li: HTMLElement, r: RowVM): void {
  const w: WhereVM = r.where;
  li.querySelector('.where')!.replaceChildren(
    ...(w.project ? [whereItem('where__project', 'repo', w.project)] : []),
    ...(w.branch ? [whereItem(`where__branch${w.branch.quiet ? ' where__branch--quiet' : ''}`, 'git-branch', w.branch)] : []),
    ...(w.worktree ? [whereItem(`where__worktree${w.worktree.gone ? ' where__worktree--gone' : ''}`, 'worktree', w.worktree)] : []),
    ...(r.missing ? [h('span', { class: 'row__missing' }, '⚠ folder missing')] : []));
  const links = li.querySelector<HTMLElement>('.links')!;
  const prs = r.links.filter(c => c.kind === 'pr'), slack = r.links.filter(c => c.kind === 'slack');
  const more = h('button', { class: 'link link--more tip tip--left', hidden: '' }, '');
  more.addEventListener('click', e => { e.stopPropagation(); openList(more, r.sessionId, r.links); });
  links.replaceChildren(...prs.map(c => chipEl(r.sessionId, c)),
    ...(prs.length && slack.length ? [h('span', { class: 'links__sep', 'aria-hidden': 'true' })] : []),
    ...slack.map(c => chipEl(r.sessionId, c)), more);
  links.hidden = r.links.length === 0;
}

/**
 * Where the links go, and how many show (D16): beside the branch on line 2 while the branch and worktree still
 * show whole; else on a line of their own. A PR that shows keeps its number — an icon alone names nothing — and
 * at most MAX_PRS show, newest first, with one Slack thread, the newest: two identical marks side by side cannot
 * be told apart. What is left, or does not fit, folds into +N at the end; its tooltip says what is behind it and
 * its list names every link. Past that, on a very narrow view, the Slack thread folds too; the newest PR never does.
 */
const MAX_PRS = 3;
/** style.css's narrow-sidebar width (its @container query): below it the title has line 1 to itself. */
const NARROW = 380;
const fitsIn = (el: HTMLElement, box: HTMLElement): boolean => el.offsetWidth <= box.clientWidth + 0.5;
const cut = (t: HTMLElement): boolean => t.scrollWidth > t.clientWidth + 1;
function fit(li: HTMLElement): void {
  const line2 = li.querySelector<HTMLElement>('.row__line--where')!, line3 = li.querySelector<HTMLElement>('.row__line--links')!;
  const links = li.querySelector<HTMLElement>('.links')!, more = links.querySelector<HTMLElement>('.link--more');
  // A narrow sidebar gives line 1 to the title alone — it is what names the session, and the state words took a
  // third of it — and the state words lead line 2 instead (D17). Wider, they sit at line 1's right end.
  const line1 = li.querySelector<HTMLElement>('.row__line')!, end = li.querySelector<HTMLElement>('.row__end')!;
  if (root.clientWidth <= NARROW) { if (end.parentElement !== line2) line2.prepend(end); }
  else if (end.parentElement !== line1) line1.querySelector('.row__title')!.after(end);
  for (const it of Array.from(line2.querySelectorAll('.where__item--icon'))) it.classList.remove('where__item--icon');
  if (!links.hidden && more) {
    const prs = Array.from(links.querySelectorAll<HTMLElement>('.link--pr')), slack = Array.from(links.querySelectorAll<HTMLElement>('.link--slack'));
    const sep = links.querySelector<HTMLElement>('.links__sep');
    const folded: HTMLElement[] = [];
    const show = (): void => {
      const label = moreLabel(folded.map(c => ({ kind: c.classList.contains('link--slack') ? 'slack' : 'pr', state: c.dataset.state })));
      more.hidden = !label;
      if (label) { more.textContent = label.text; more.dataset.tip = label.tip; more.setAttribute('aria-label', label.tip); }
      if (sep) sep.hidden = !(prs.some(c => !c.hidden) && slack.some(c => !c.hidden));
    };
    const fold = (c: HTMLElement): void => { c.hidden = true; folded.push(c); };
    for (const c of [...prs, ...slack]) c.hidden = false;
    prs.slice(MAX_PRS).forEach(fold); slack.slice(1).forEach(fold);
    show();
    line2.querySelector('.row__fill')!.before(links); line3.hidden = true;
    if (Array.from(line2.querySelectorAll<HTMLElement>('.where__txt')).some(cut)) {
      line3.hidden = false; line3.append(links);
      for (let i = Math.min(prs.length, MAX_PRS) - 1; i >= 1 && !fitsIn(links, line3); i--) { fold(prs[i]!); show(); }
      if (prs.length && slack[0] && !slack[0].hidden && !fitsIn(links, line3)) { fold(slack[0]); show(); }
    }
  } else line3.hidden = true;
  // A title cut short names itself in our tooltip. Not a native `title` on the row, which showed over every other
  // tooltip on it (0.10.0); an uncut title needs none.
  const title = li.querySelector<HTMLElement>('.row__title')!;
  if (cut(title)) { title.classList.add('tip'); if (title.dataset.tip !== title.textContent) title.dataset.tip = title.textContent ?? ''; }
  else if (title.classList.contains('tip')) { title.classList.remove('tip'); delete title.dataset.tip; }
  // A worktree or project squeezed past a readable name keeps only its icon; hovering still names it.
  for (const it of Array.from(line2.querySelectorAll<HTMLElement>('.where__worktree, .where__project'))) {
    const t = it.querySelector<HTMLElement>('.where__txt')!;
    if (cut(t) && t.clientWidth < 56) it.classList.add('where__item--icon');
  }
}

/** The list width each row was last fitted at; a row is refitted when the width changes or its links do. */
const fitted = new WeakMap<HTMLElement, number>();
let fitQueued = false;
function fitSoon(): void {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    const width = sectionsEl.clientWidth;
    for (const li of Array.from(sectionsEl.querySelectorAll<HTMLElement>('.row[data-id]'))) {
      if (fitted.get(li) === width || !li.offsetParent) continue;   // done, or in a collapsed section
      fit(li); fitted.set(li, width);
    }
    holdActive(width);   // rows refitted: a third line made ACTIVE taller, or a new width re-wrapped them all
  });
}

/**
 * ACTIVE's height only grows while the view keeps its width (activeReserve); a section rebuilt after the filter gets
 * it back. A new width re-measures from the rows as they now wrap — else a sidebar widened from 290 px kept the
 * height of three-line rows over two-line ones. `width` comes only from fitSoon, after the rows are refitted.
 */
let activeHeld = 0, heldWidth = -1;
function holdActive(width?: number): void {
  const body = sectionsEl.querySelector<HTMLElement>('section[data-id="active"]:not([data-collapsed="true"]) .section__body');
  const content = body?.firstElementChild as HTMLElement | null | undefined;
  if (!body || !content) return;
  if (width !== undefined && width !== heldWidth) { heldWidth = width; activeHeld = 0; }
  activeHeld = activeReserve(activeHeld, content.offsetHeight, parseFloat(getComputedStyle(root).getPropertyValue('--row')) || 44);
  if (body.style.minHeight !== `${activeHeld}px`) body.style.minHeight = `${activeHeld}px`;
}
new ResizeObserver(fitSoon).observe(sectionsEl);
void document.fonts?.ready.then(() => { for (const li of Array.from(sectionsEl.querySelectorAll<HTMLElement>('.row[data-id]'))) fitted.delete(li); fitSoon(); });

// ---------------------------------------------------------------- the list behind +N

const list = h('div', { class: 'links-list', role: 'menu', hidden: '' });
document.body.append(list);
let listAnchor: HTMLElement | null = null;
function closeList(): void { if (!list.hidden) { list.hidden = true; list.replaceChildren(); } }
function openList(anchor: HTMLElement, sessionId: string, chips: ChipVM[]): void {
  listAnchor = anchor;
  list.replaceChildren(...chips.map(c => {
    const item = h('button', { class: 'links-list__item', role: 'menuitem', title: c.tip, ...(c.state ? { 'data-state': c.state } : {}) },
      chipIcon(c), h('span', { class: 'links-list__main' }, c.kind === 'pr' ? c.label : 'Slack thread'),
      h('span', { class: 'links-list__sub' }, c.detail));
    item.addEventListener('click', e => { e.stopPropagation(); closeList(); openLink(sessionId, c.url); });
    return item;
  }));
  list.hidden = false;
  const a = anchor.getBoundingClientRect();
  list.style.left = `${Math.max(4, Math.min(a.left, window.innerWidth - list.offsetWidth - 4))}px`;
  const below = a.bottom + 2;
  list.style.top = `${below + list.offsetHeight > window.innerHeight - 4 ? Math.max(4, a.top - list.offsetHeight - 2) : below}px`;
  list.querySelector<HTMLElement>('button')?.focus();
}
document.addEventListener('click', e => { if (!list.contains(e.target as Node)) closeList(); });
// The list sits outside the rows, so its keys never reach the list shortcuts: Escape goes back to +N, the arrows walk it.
list.addEventListener('keydown', e => {
  const items = Array.from(list.querySelectorAll<HTMLElement>('button'));
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === 'Escape') { closeList(); listAnchor?.focus(); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus(); }
});
window.addEventListener('blur', closeList);
sectionsEl.addEventListener('scroll', closeList, { passive: true });
window.addEventListener('scroll', closeList, { passive: true });

/** The time and its tooltip, which says what the number measures — or neither, on an old row whose age tag stands in for it. */
function setTime(el: HTMLElement, label: string, tip: string | undefined): void {
  if (el.textContent !== label) el.textContent = label;
  const shown = label && tip ? tip : '';
  el.classList.toggle('tip', !!shown);
  if (shown) { if (el.dataset.tip !== shown) el.dataset.tip = shown; } else delete el.dataset.tip;
}

/** The age tag: text when the session is past the window, empty (and hidden by CSS) otherwise. */
function setAge(el: HTMLElement, age: AgeTag | undefined): void {
  if (!age) { if (el.textContent) { el.textContent = ''; delete el.dataset.tip; delete el.dataset.tier; el.removeAttribute('aria-label'); } return; }
  if (el.textContent !== age.label) el.textContent = age.label;
  el.dataset.tier = age.tier; el.dataset.tip = age.title; el.setAttribute('aria-label', age.title);
}

function rowEl(r: RowVM | LinkVM): HTMLLIElement {
  if (r.kind === 'link') {
    const li = h('li', { class: 'row row--link', tabindex: '-1', 'data-action': r.action, 'data-key': keyOf(r) },
      h('i', { class: `row__icon ${r.iconClass}`, 'aria-hidden': 'true' }),
      h('span', { class: 'row__lines' }, h('span', { class: 'row__line' },
        h('span', { class: 'row__title' }, r.title),
        h('span', { class: 'row__time' }, r.meta))));
    li.addEventListener('click', () => linkAction(r.action));
    updateRow(li, r);
    return li;
  }
  const id = r.sessionId;
  const li = h('li', { class: 'row', tabindex: '-1', 'data-id': id, 'data-key': keyOf(r) });
  // Click resumes in a tab — or, for a headless run, reads it here (D15, decided by the host) — so no button
  // repeats that. Four that look, each saying what, then the one that closes.
  const close = actionButton('close', 'Close: move to Closed and close its tab (Delete)', () => post({ type: 'close', sessionId: id }));
  close.classList.add('action--close');
  const actions = h('span', { class: 'row__actions' },
    actionButton('type-hierarchy', 'Read it here: agents, timeline, transcript (V)', () => post({ type: 'view', sessionId: id })),
    actionButton('layout-sidebar-right', 'Resume in the right panel (Shift+Enter)', () => post({ type: 'open', sessionId: id, where: 'right' })),
    actionButton('link', 'Copy a link that reopens this session', () => post({ type: 'copyLink', sessionId: id })),
    actionButton('file-code', 'Open the raw transcript file (T)', () => post({ type: 'transcript', sessionId: id })),
    close,
  );
  // Lines that size on their own. Line 1: title, then the time, then the actions in a spot that is
  // theirs whether or not they show — the × in the top-right corner. Line 2: where the work is (branch,
  // worktree), the links while they fit beside it (fit()), then the age tag (which stands in for the time
  // on an old row) and the cost meter. Line 3, when needed: the links. Nothing moves on hover.
  li.append(
    h('i', { class: 'row__icon', role: 'img' }),
    h('span', { class: 'row__lines' },
      h('span', { class: 'row__line' },
        h('span', { class: 'row__title' }),
        h('span', { class: 'row__end' }, h('span', { class: 'row__time' })),
        actions),
      h('span', { class: 'row__line row__line--where' },
        h('span', { class: 'where' }),
        h('span', { class: 'links', hidden: '' }),
        h('span', { class: 'row__fill' }),
        h('span', { class: 'row__age tip' }),
        h('span', { class: 'row__heat tip', role: 'img' })),
      h('span', { class: 'row__line row__line--links', hidden: '' })),
  );
  li.addEventListener('click', () => post({ type: 'open', sessionId: id, where: 'tab' }));
  updateRow(li, r);
  return li;
}

/**
 * Make `ul` show `rows`, touching as little as possible. Existing rows are updated in place; new ones
 * are created (and fade in); gone ones are removed. If the order changed and the pointer is over the
 * list, existing rows stay where they are (`hold`) and the caller is told; otherwise rows move with a
 * FLIP slide. Returns whether a reorder was deferred.
 */
function reconcileList(ul: HTMLUListElement, rows: Array<RowVM | LinkVM>, hold: boolean): boolean {
  const existing = new Map<string, HTMLLIElement>();
  const before = new Map<string, number>();
  for (const li of Array.from(ul.children) as HTMLLIElement[]) {
    const k = li.dataset.key ?? '';
    existing.set(k, li);
    before.set(k, li.getBoundingClientRect().top);
  }
  const desired = rows.map(r => {
    const k = keyOf(r);
    const li = existing.get(k);
    if (li) { updateRow(li, r); existing.delete(k); return li; }
    const fresh = rowEl(r);
    fresh.classList.add('row--new');
    fresh.addEventListener('animationend', () => fresh.classList.remove('row--new'), { once: true });
    return fresh;
  });
  for (const li of existing.values()) li.remove();
  const current = Array.from(ul.children);
  const sameOrder = current.length === desired.length && current.every((li, i) => li === desired[i]);
  if (sameOrder) return false;
  if (hold) {
    // keep what is on screen where it is; only new rows join, at the end of their section
    for (const li of desired) if (!li.isConnected) ul.append(li);
    return true;
  }
  for (const li of desired) ul.append(li);                     // appending a connected node moves it
  if (!reducedMotion) {
    for (const li of desired) {
      const from = before.get(li.dataset.key ?? '');
      if (from === undefined) continue;
      const dy = from - li.getBoundingClientRect().top;
      if (!dy) continue;
      li.style.transition = 'none'; li.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => {
        li.style.transition = 'transform 220ms var(--ease)'; li.style.transform = '';
        li.addEventListener('transitionend', () => { li.style.transition = ''; }, { once: true });
      });
    }
  }
  return false;
}

// ---------------------------------------------------------------- sections

function skeletonEl(): HTMLElement[] {
  return [0, 1, 2].map(i => h('div', { class: 'skeleton' }, h('span', {}),
    h('span', { class: `skeleton__bar${i % 2 ? ' skeleton__bar--short' : ''}` })));
}

/** Find or create the section, update its header, then reconcile its body. */
function reconcileSection(s: SectionVM, hold: boolean): { el: HTMLElement; deferred: boolean } {
  const collapsed = s.id !== 'results' && ui.collapsed[s.id] === true;
  let el = sectionsEl.querySelector<HTMLElement>(`section[data-id="${s.id}"]`);
  if (!el) {
    const header = h('button', { class: 'section__header' },
      h('i', { class: 'section__chevron codicon codicon-chevron-down', 'aria-hidden': 'true' }),
      h('span', { class: 'section__label' }, s.label),
      h('span', { class: 'section__count' }, String(s.count)));
    header.addEventListener('click', () => { ui.collapsed[s.id] = !(ui.collapsed[s.id] === true); api.setState(ui); render(true); });
    el = h('section', { class: 'section', 'data-id': s.id }, header, h('div', { class: 'section__body' }));
  }
  el.dataset.collapsed = String(collapsed);
  el.querySelector('.section__header')!.setAttribute('aria-expanded', String(!collapsed));
  const count = el.querySelector<HTMLElement>('.section__count')!;
  if (count.textContent !== String(s.count)) count.textContent = String(s.count);
  const body = el.querySelector<HTMLElement>('.section__body')!;
  if (s.skeleton) { if (!body.querySelector('.skeleton')) body.replaceChildren(...skeletonEl()); return { el, deferred: false }; }
  if (s.empty) { const cur = body.querySelector('.empty'); if (!cur || cur.textContent !== s.empty) body.replaceChildren(h('div', { class: 'empty' }, s.empty)); return { el, deferred: false }; }
  let ul = body.querySelector<HTMLUListElement>('ul.list');
  // A list, not a listbox: a row holds buttons (its actions, its links), and an option's content is presentational —
  // a screen reader would flatten them. The session behind the active tab is aria-current, not "selected".
  if (!ul) { ul = h('ul', { class: 'list', 'aria-label': s.label }); body.replaceChildren(ul); }
  return { el, deferred: reconcileList(ul, s.rows, hold) };
}

const hostNow = (): number => Date.now() + clockOffset;
const viewOpts = (): ViewOpts => ({ activeWindowLabel: activeWindow, activeWindowMs, searchKey, reducedMotion, activeId, contextBudget });

/** `force`: a user action (filter, collapse, mode switch) — never hold the order for those. */
function render(force = false): void {
  if (!snapshot) return;
  const focusedId = (document.activeElement as HTMLElement | null)?.dataset.id;
  const opts = viewOpts();
  const q = ui.filter ?? '';
  const vm: ViewModel = filtering()
    ? resultsModel(results && results.q === q ? results.rows : null, q, results?.deep ?? false, hostNow(), opts)
    : viewModel(snapshot, hostNow(), opts);
  const hold = !force && sectionsEl.matches(':hover');
  let deferred = false;
  const els = vm.sections.map(s => { const r = reconcileSection(s, hold); deferred = deferred || r.deferred; return r.el; });
  const wanted = new Set(vm.sections.map(s => s.id));
  for (const el of Array.from(sectionsEl.querySelectorAll<HTMLElement>('section[data-id]'))) if (!wanted.has(el.dataset.id as SectionVM['id'])) el.remove();
  els.forEach((el, i) => { if (sectionsEl.children[i] !== el) sectionsEl.insertBefore(el, sectionsEl.children[i] ?? null); });
  orderPending = deferred;
  holdActive();
  if (focusedId) sectionsEl.querySelector<HTMLElement>(`[data-id="${focusedId}"]`)?.focus();
  // Follow the active tab into view once per change — not on every snapshot, which would fight the user's scrolling.
  if (activeId && activeId !== scrolledTo) {
    const sel = sectionsEl.querySelector<HTMLElement>('.row[aria-current="true"]');
    if (sel) { sel.scrollIntoView({ block: 'nearest' }); scrolledTo = activeId; }
  }
}
sectionsEl.addEventListener('mouseleave', () => { if (orderPending) render(true); });

/** Between snapshots only the relative-time labels change (spec §8) — update those, and the age tag a session may just have earned, not the tree. */
function refreshTimes(): void {
  if (!snapshot) return;
  const now = hostNow(); const opts = viewOpts();
  const rows = filtering()
    ? (results?.rows ?? []).flatMap(r => r.live ? [{ sessionId: r.sessionId, ...(r.headless ? { headless: true as const } : {}), ...r.live }] : [])
    : snapshot.active;
  for (const r of rows) {
    const li = sectionsEl.querySelector<HTMLElement>(`.row[data-id="${r.sessionId}"]`);
    if (!li) continue;
    const age = ageTag(r, now, opts);
    const el = li.querySelector<HTMLElement>('.row__time');
    if (el) setTime(el, age ? '' : timeLabel(r, now), timeTip(r, now));
    const ageEl = li.querySelector<HTMLElement>('.row__age');
    if (ageEl) { const was = ageEl.textContent; setAge(ageEl, age); if (ageEl.textContent !== was) { fitted.delete(li); fitSoon(); } }
  }
}

/** Roving focus: ↑/↓ move, Enter opens in a tab, Shift+Enter in the right panel, T transcript, V view, Delete closes, / filter. */
root.addEventListener('keydown', e => {
  if (e.target === filterInput || e.metaKey || e.ctrlKey || e.altKey) return;   // typing, or a chord for VS Code (Cmd+V is not V)
  if (e.target instanceof HTMLButtonElement && (e.key === 'Enter' || e.key === ' ')) return;   // a focused link or action does its own
  const rows = Array.from(sectionsEl.querySelectorAll<HTMLElement>('.row'));   // not [...], which needs lib dom.iterable
  // the row, also when focus is on one of its buttons (an action, a link): ↓ from there is the next row, not the first
  const current = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.row') ?? null;
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
    case 'Delete': case 'Backspace': if (id) { e.preventDefault(); post({ type: 'close', sessionId: id }); } break;   // the host ignores a closed row
    case '/': e.preventDefault(); focusFilter(); break;
    case 'Escape': if (filtering()) setFilter(''); else (document.activeElement as HTMLElement | null)?.blur(); break;
  }
});
// Tab lands on <main>; hand focus to the first row so the roving list takes over.
root.addEventListener('focus', () => firstRow()?.focus());

window.addEventListener('message', (e: MessageEvent<Inbound>) => {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  switch (m.type) {
    case 'snapshot': {
      const scopeChanged = snapshot !== null && snapshot.scope !== m.snapshot.scope;
      snapshot = m.snapshot; activeWindow = m.activeWindow; activeWindowMs = m.activeWindowMs; contextBudget = m.contextBudget; clockOffset = m.now - Date.now(); activeId = m.active;
      render(scopeChanged);
      if (filtering()) post({ type: 'filter', q: ui.filter ?? '' });   // the index moved; re-ask so results stay current
      return;
    }
    case 'results':
      if (m.q !== (ui.filter ?? '')) return;                           // a stale answer for text we left behind
      results = { q: m.q, deep: m.deep, rows: m.rows }; clockOffset = m.now - Date.now();
      render(true);
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
