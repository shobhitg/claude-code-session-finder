import { describe, it, expect } from 'vitest';
import { fmtDuration, timeLabel, historyLabel, metaLabel, iconClass, viewModel, resultsModel, heatOf, fmtWindow, ageTag } from '../src/webview/model.js';
import type { Snapshot, LiveRow, HistoryRow, SearchRow } from '../src/core/rows.js';

const S = 1_000, M = 60 * S, H = 60 * M;
const now = 1_000 * H;
const live = (o: Partial<LiveRow>): LiveRow => ({
  sessionId: 'a', title: 'Ledger GUI', project: 'aida', branch: 'shobhit/ledger', pr: 20231, cwdExists: true,
  state: 'running', lastWriteMs: now - 10 * S, ...o,
});
const hist = (o: Partial<HistoryRow>): HistoryRow => ({
  sessionId: 'h', title: 'Old', project: 'aida', branch: null, pr: null, cwdExists: true,
  lastTs: new Date(2026, 8, 15, 12).getTime(), msgCount: 31, touchedTs: new Date(2026, 8, 15, 11).getTime(), ...o,
});

describe('fmtDuration', () => {
  it('picks the unit by magnitude', () => {
    expect(fmtDuration(40 * S)).toBe('40s');
    expect(fmtDuration(3 * M + 20 * S)).toBe('3m');
    expect(fmtDuration(2.1 * H)).toBe('2h 6m');
    expect(fmtDuration(3 * H)).toBe('3h');
    expect(fmtDuration(59 * M + 50 * S)).toBe('1h');                       // rounded to the minute first, then split
    expect(fmtDuration(49 * H + 50 * M)).toBe('2d 1h');
    expect(fmtDuration(25 * H)).toBe('1d 1h');
    expect(fmtDuration(72 * H)).toBe('3d');
    expect(fmtDuration(-5)).toBe('0s');
  });
});

describe('timeLabel (spec §10 table)', () => {
  it('running: just now, then quiet N', () => {
    expect(timeLabel(live({ lastWriteMs: now - 10 * S }), now)).toBe('just now');
    expect(timeLabel(live({ lastWriteMs: now - 2 * M }), now)).toBe('quiet 2m');
  });
  it('tool-or-permission says quiet; your-turn says done; a question asks; an interruption says so; stalled is bare', () => {
    expect(timeLabel(live({ state: 'attention', reason: 'tool-or-permission', lastWriteMs: now - 3 * M }), now)).toBe('quiet 3m');
    expect(timeLabel(live({ state: 'attention', reason: 'your-turn', lastWriteMs: now - 3 * M }), now)).toBe('done · 3m ago');
    expect(timeLabel(live({ state: 'attention', reason: 'question', lastWriteMs: now - 40 * S }), now)).toBe('asks you · 40s');
    expect(timeLabel(live({ state: 'attention', reason: 'interrupted', lastWriteMs: now - 2 * M }), now)).toBe('interrupted · 2m');
    expect(timeLabel(live({ state: 'attention', reason: 'stalled', lastWriteMs: now - 2.1 * H }), now)).toBe('2h 6m');
  });
});

describe('historyLabel / metaLabel / iconClass', () => {
  it('history shows the local date and message count', () => {
    expect(historyLabel(hist({}))).toBe('Sep 15 · 31 msgs');
  });
  it('the date is the day you last touched the session — CLOSED\'s order — not Claude\'s last write', () => {
    expect(historyLabel(hist({ touchedTs: new Date(2026, 8, 14, 23, 50).getTime(), lastTs: new Date(2026, 8, 15, 0, 30).getTime() }))).toBe('Sep 14 · 31 msgs');
  });
  it('meta joins project, branch and PR with middots, skipping blanks', () => {
    expect(metaLabel(live({}))).toBe('aida · shobhit/ledger · PR #20231');
    expect(metaLabel(hist({ project: '', branch: null, pr: null }))).toBe('');
  });
  it('iconClass expands the ~spin modifier', () => {
    expect(iconClass('loading~spin')).toBe('codicon codicon-loading codicon-modifier-spin');
    expect(iconClass('bell-dot')).toBe('codicon codicon-bell-dot');
  });
});

describe('viewModel', () => {
  const snap: Snapshot = {
    active: [live({ sessionId: 'a' }), live({ sessionId: 'b', state: 'attention', reason: 'your-turn', cwdExists: false })],
    history: [hist({ sessionId: 'h' })],
    totalSessions: 40, indexing: false, scope: 'all', hiddenHeadless: 0,
  };
  const opts = { activeWindowLabel: '4h', searchKey: 'Ctrl+Alt+S' };

  it('builds ACTIVE and CLOSED (HISTORY in the data model) with counts, states and the search-all link', () => {
    const vm = viewModel(snap, now, opts);
    expect(vm.sections.map(s => [s.id, s.label, s.count])).toEqual([['active', 'Active', 2], ['history', 'Closed', 38]]);
    const [active, history] = vm.sections;
    expect(active!.rows[0]).toMatchObject({ kind: 'session', sessionId: 'a', state: 'running', missing: false,
                                            iconClass: 'codicon codicon-loading codicon-modifier-spin' });
    expect(active!.rows[1]).toMatchObject({ kind: 'session', state: 'attention', reason: 'your-turn', missing: true,
                                            iconClass: 'codicon codicon-comment-discussion' });
    expect(history!.rows[0]).toMatchObject({ kind: 'session', sessionId: 'h', state: 'history', time: 'Sep 15 · 31 msgs', stateLabel: 'Closed · click to resume' });
    expect(history!.rows.at(-2)).toEqual({ kind: 'link', title: 'Search all 40 sessions…', meta: 'Ctrl+Alt+S',
                                            iconClass: 'codicon codicon-search', action: 'search' });
    expect(history!.rows.at(-1)).toMatchObject({ kind: 'link', action: 'scope', title: 'All projects · show this workspace only' });
  });
  it('marks the active tab\'s session selected and names the scope', () => {
    const vm = viewModel({ ...snap, scope: 'workspace' }, now, { ...opts, activeId: 'h' });
    expect(vm.sections[0]!.rows.map(r => r.kind === 'session' && r.selected)).toEqual([false, false]);
    expect(vm.sections[1]!.rows[0]).toMatchObject({ sessionId: 'h', selected: true });
    expect(vm.sections[1]!.rows.at(-1)).toMatchObject({ action: 'scope', title: 'This workspace only · show all projects' });
    expect(viewModel({ ...snap, active: [], scope: 'workspace' }, now, opts).sections[0]!.empty).toContain('in this workspace');
  });
  it('empty ACTIVE explains the window; indexing shows a skeleton and no link', () => {
    const vm = viewModel({ active: [], history: [], totalSessions: 0, indexing: true, scope: 'all', hiddenHeadless: 0 }, now, opts);
    expect(vm.sections[0]!.empty).toBe('Nothing running. Sessions touched in the last 4h, or open in a tab, appear here.');
    expect(vm.sections[1]!.skeleton).toBe(true);
    expect(vm.sections[1]!.rows).toEqual([]);
  });
  it('reduced motion swaps the spinner for a static dot', () => {
    const vm = viewModel(snap, now, { ...opts, reducedMotion: true });
    expect(vm.sections[0]!.rows[0]).toMatchObject({ iconClass: 'codicon codicon-circle-large-filled' });
  });
});

describe('resultsModel (the inline filter)', () => {
  const opts = { activeWindowLabel: '4h', searchKey: 'Ctrl+Alt+S', activeId: 'r2' };
  const row = (o: Partial<SearchRow>): SearchRow => ({ ...hist({}), snippet: null, matches: 1, ...o });
  it('is one RESULTS section whose rows keep live state and carry the matching line', () => {
    const vm = resultsModel([
      row({ sessionId: 'r1', snippet: '…paste the image…', matches: 3, live: { state: 'running', lastWriteMs: now - 10 * S } }),
      row({ sessionId: 'r2' }),
    ], 'paste', false, now, opts);
    expect(vm.sections.map(s => [s.id, s.count])).toEqual([['results', 2]]);
    expect(vm.sections[0]!.rows[0]).toMatchObject({ sessionId: 'r1', state: 'running', time: 'just now', snippet: '…paste the image…', selected: false });
    expect(vm.sections[0]!.rows[1]).toMatchObject({ sessionId: 'r2', state: 'history', selected: true });
    expect(vm.sections[0]!.rows[1]).not.toHaveProperty('snippet');
  });
  it('shows a skeleton until the host answers, an empty message for no matches, and sends deep searches to the picker', () => {
    expect(resultsModel(null, 'x', false, now, opts).sections[0]).toMatchObject({ skeleton: true, empty: null });
    expect(resultsModel([], 'zzz ', false, now, opts).sections[0]!.empty).toBe('No sessions match “zzz”.');
    expect(resultsModel([], '!npm', true, now, opts).sections[0]!.empty).toContain('picker (Ctrl+Alt+S)');
  });
});

describe('the bell on a row', () => {
  const opts = { activeWindowLabel: '4h', searchKey: 'k' };
  it('a live row that rings says so; one you have seen does not', () => {
    const vm = viewModel({ active: [live({ sessionId: 'r', state: 'attention', reason: 'your-turn', ringing: true }), live({ sessionId: 's', state: 'attention', reason: 'your-turn' })],
                           history: [], totalSessions: 2, indexing: false, scope: 'all', hiddenHeadless: 0 }, now, opts);
    expect(vm.sections[0]!.rows[0]).toMatchObject({ sessionId: 'r', ringing: true });
    expect(vm.sections[0]!.rows[1]).not.toHaveProperty('ringing');
  });
  it('so does a filter result with a ringing live state', () => {
    const row: SearchRow = { ...hist({ sessionId: 'r' }), snippet: null, matches: 1, live: { state: 'attention', reason: 'question', lastWriteMs: now, ringing: true } };
    expect(resultsModel([row], 'x', false, now, opts).sections[0]!.rows[0]).toMatchObject({ ringing: true });
  });
});

describe('ACTIVE keeps the host order (D14: the host orders by your last act, which Claude never moves)', () => {
  const opts = { activeWindowLabel: '4h', activeWindowMs: 4 * H, searchKey: 'Ctrl+Alt+S' };
  it('renders the rows as the host sent them, whatever their state or age', () => {
    const active = [
      live({ sessionId: 'new', state: 'running' }),
      live({ sessionId: 'done', state: 'attention', reason: 'your-turn', lastWriteMs: now - 48 * S }),
      live({ sessionId: 'asks', state: 'attention', reason: 'question', lastWriteMs: now - 5 * M }),
      live({ sessionId: 'old', state: 'attention', reason: 'your-turn', lastWriteMs: now - 13 * H }),
    ];
    const rows = viewModel({ active, history: [], totalSessions: 4, indexing: false, scope: 'all', hiddenHeadless: 0 }, now, opts).sections[0]!.rows;
    expect(rows.map(r => r.kind === 'session' ? r.sessionId : r.action)).toEqual(['new', 'done', 'asks', 'old']);
  });
});

describe('heatOf (the cost meter): one absolute scale, five tiers', () => {
  it('ramps green → yellow → orange → red toward the budget and pins full past it — the same for every model', () => {
    expect(heatOf(168_000)).toMatchObject({ pct: 17, tier: 'low', label: '168k', budget: 1_000_000 });
    expect(heatOf(420_000)).toMatchObject({ pct: 42, tier: 'mid', label: '420k' });
    expect(heatOf(622_000)).toMatchObject({ pct: 62, tier: 'warm', label: '622k' });
    expect(heatOf(850_000)).toMatchObject({ pct: 85, tier: 'high' });
    expect(heatOf(1_300_000)).toMatchObject({ pct: 100, tier: 'full', label: '1.3M' });
    expect(heatOf(850_000).title).toContain('compaction is near');
    expect(heatOf(1_300_000).title).toContain('compact or start a new session');
  });
  it('honours the configured budget', () => {
    expect(heatOf(168_000, 200_000)).toMatchObject({ pct: 84, tier: 'high' });
    expect(heatOf(50, 0).pct).toBe(100);                                   // a nonsense budget cannot divide by zero
  });
  it('rides on the row when the live state carries a context size, using the budget from options', () => {
    const vm = viewModel({ active: [live({ sessionId: 'a', contextTokens: 168_000, model: 'claude-opus-5' }), live({ sessionId: 'b' })],
                           history: [], totalSessions: 2, indexing: false, scope: 'all', hiddenHeadless: 0 }, now, { activeWindowLabel: '4h', searchKey: 'k', contextBudget: 200_000 });
    expect(vm.sections[0]!.rows[0]).toMatchObject({ heat: { tier: 'high', label: '168k' } });
    expect(vm.sections[0]!.rows[1]).not.toHaveProperty('heat');
  });
});

describe('the age tag: an ACTIVE session older than the window is there only because its tab is open', () => {
  const opts = { activeWindowLabel: '4h', activeWindowMs: 4 * H, searchKey: 'k' };
  it('fmtWindow spells the setting out', () => {
    expect(fmtWindow('4h')).toBe('4 hours');
    expect(fmtWindow('1h')).toBe('1 hour');
    expect(fmtWindow('1d')).toBe('1 day');
    expect(fmtWindow('2w')).toBe('2 weeks');
    expect(fmtWindow('nonsense')).toBe('nonsense');
  });
  it('says how old in whole hours, then days and hours, and turns stale after a day; the tooltip keeps the time label it replaces', () => {
    const at = (ms: number) => ageTag(live({ state: 'attention', reason: 'your-turn', lastWriteMs: now - ms }), now, opts);
    expect(at(3 * H)).toBeUndefined();
    expect(at(4.5 * H)).toMatchObject({ label: '> 4h', tier: 'old' });
    expect(at(19.2 * H)).toMatchObject({ label: '> 19h', tier: 'old' });
    expect(at(24.5 * H)).toMatchObject({ label: '> 1d', tier: 'stale' });
    expect(at(26 * H)).toMatchObject({ label: '> 1d 2h', tier: 'stale' });
    expect(at(49.9 * H)).toMatchObject({ label: '> 2d 1h', tier: 'stale' });
    expect(at(26 * H)!.title).toContain('done · 1d 2h ago');
    expect(at(26 * H)!.title).toContain('4 hours');
  });
  it('ageTag appears past the window, in the row and in results', () => {
    const old = live({ sessionId: 'o', state: 'attention', reason: 'your-turn', lastWriteMs: now - 26 * H });
    expect(ageTag(live({ lastWriteMs: now - 3 * H }), now, opts)).toBeUndefined();
    expect(ageTag(old, now, { activeWindowLabel: '4h', searchKey: 'k' })).toBeUndefined();          // no window known: no tag
    const vm = viewModel({ active: [old, live({ sessionId: 'a' })], history: [], totalSessions: 2, indexing: false, scope: 'all', hiddenHeadless: 0 }, now, opts);
    expect(vm.sections[0]!.rows[0]).toMatchObject({ sessionId: 'o', age: { label: '> 1d 2h', tier: 'stale' } });
    expect(vm.sections[0]!.rows[1]).not.toHaveProperty('age');
    expect(vm.sections[0]!.empty).toBeNull();
    expect(viewModel({ active: [], history: [], totalSessions: 0, indexing: false, scope: 'all', hiddenHeadless: 0 }, now, opts).sections[0]!.empty).toContain('open in a tab');
  });
});

describe('headless rows (D15): the ghost in the icon slot, a dot for how the run is doing', () => {
  const opts = { activeWindowLabel: '4h', searchKey: 'Ctrl+Alt+S' };
  const one = (r: LiveRow | HistoryRow, isLive = true) => viewModel({ active: isLive ? [r as LiveRow] : [], history: isLive ? [] : [r as HistoryRow],
    totalSessions: 1, indexing: false, scope: 'all', hiddenHeadless: 0 }, now, opts).sections[isLive ? 0 : 1]!.rows[0]!;

  it('maps each state to a dot — a -p run never waits on a permission prompt, so a quiet tool call is still running', () => {
    const ghostOf = (o: Partial<LiveRow>) => (one(live({ headless: true, ...o })) as { ghost?: string }).ghost;
    expect(ghostOf({ state: 'running' })).toBe('running');
    expect(ghostOf({ state: 'attention', reason: 'tool-or-permission' })).toBe('running');
    expect(ghostOf({ state: 'attention', reason: 'your-turn' })).toBe('done');
    expect(ghostOf({ state: 'attention', reason: 'interrupted' })).toBe('failed');
    expect(ghostOf({ state: 'attention', reason: 'question' })).toBe('waiting');
    expect(ghostOf({ state: 'attention', reason: 'stalled' })).toBe('stalled');
    expect((one(hist({ headless: true }), false) as { ghost?: string }).ghost).toBe('closed');
  });

  it('the tooltip says it in words, and that a click reads it rather than resuming it', () => {
    expect(one(live({ headless: true, state: 'attention', reason: 'your-turn' }))).toMatchObject({ stateLabel: 'Headless run (claude -p) — finished · click to read it' });
    expect(one(hist({ headless: true }), false)).toMatchObject({ stateLabel: 'Headless run (claude -p) — closed · click to read it' });
  });

  it('an interactive row has no ghost', () => {
    expect(one(live({}))).not.toHaveProperty('ghost');
    expect(one(hist({}), false)).not.toHaveProperty('ghost');
  });

  it('a search result keeps the ghost', () => {
    const row = (o: Partial<SearchRow>): SearchRow => ({ ...hist({}), snippet: null, matches: 1, ...o });
    const vm = resultsModel([row({ headless: true, live: { state: 'running', lastWriteMs: now } }), row({ headless: true })], 'promo', false, now, opts);
    expect(vm.sections[0]!.rows.map(r => (r as { ghost?: string }).ghost)).toEqual(['running', 'closed']);
  });

  it('hidden runs: a link counts them and brings them back, and CLOSED\'s count leaves them out', () => {
    const snap: Snapshot = { active: [live({})], history: [hist({})], totalSessions: 40, indexing: false, scope: 'all', hiddenHeadless: 3 };
    const vm = viewModel(snap, now, opts);
    expect(vm.sections[1]!.count).toBe(36);
    expect(vm.sections[1]!.rows.at(-1)).toEqual({ kind: 'link', title: '3 headless runs hidden · show', meta: '', iconClass: '', action: 'headless', ghost: true });
    expect(viewModel({ ...snap, hiddenHeadless: 1 }, now, opts).sections[1]!.rows.at(-1)).toMatchObject({ title: '1 headless run hidden · show' });
    expect(viewModel({ ...snap, hiddenHeadless: 0 }, now, opts).sections[1]!.rows.at(-1)).toMatchObject({ action: 'scope' });
  });
});
