import { describe, it, expect } from 'vitest';
import { fmtDuration, timeLabel, historyLabel, metaLabel, iconClass, viewModel, resultsModel, stableOrder, noteArrivals, heatOf, fmtWindow, ageTag, type Arrivals } from '../src/webview/model.js';
import type { Snapshot, LiveRow, HistoryRow, SearchRow } from '../src/core/rows.js';

const S = 1_000, M = 60 * S, H = 60 * M;
const now = 1_000 * H;
const live = (o: Partial<LiveRow>): LiveRow => ({
  sessionId: 'a', title: 'Ledger GUI', project: 'aida', branch: 'shobhit/ledger', pr: 20231, cwdExists: true,
  state: 'running', lastWriteMs: now - 10 * S, ...o,
});
const hist = (o: Partial<HistoryRow>): HistoryRow => ({
  sessionId: 'h', title: 'Old', project: 'aida', branch: null, pr: null, cwdExists: true,
  lastTs: new Date(2026, 8, 15, 12).getTime(), msgCount: 31, ...o,
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
    totalSessions: 40, indexing: false, scope: 'all',
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
    const vm = viewModel({ active: [], history: [], totalSessions: 0, indexing: true, scope: 'all' }, now, opts);
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
                           history: [], totalSessions: 2, indexing: false, scope: 'all' }, now, opts);
    expect(vm.sections[0]!.rows[0]).toMatchObject({ sessionId: 'r', ringing: true });
    expect(vm.sections[0]!.rows[1]).not.toHaveProperty('ringing');
  });
  it('so does a filter result with a ringing live state', () => {
    const row: SearchRow = { ...hist({ sessionId: 'r' }), snippet: null, matches: 1, live: { state: 'attention', reason: 'question', lastWriteMs: now, ringing: true } };
    expect(resultsModel([row], 'x', false, now, opts).sections[0]!.rows[0]).toMatchObject({ ringing: true });
  });
});

describe('stableOrder + noteArrivals: rows stay put, and enter their group at the top', () => {
  const opts = { activeWindowLabel: '4h', activeWindowMs: 4 * H, searchKey: 'Ctrl+Alt+S' };
  const snap: Snapshot = {
    active: [
      live({ sessionId: 'p', state: 'attention', reason: 'tool-or-permission' }),
      live({ sessionId: 'r1', lastWriteMs: now - 1 * S }),          // host: most recently written running first
      live({ sessionId: 'r2', lastWriteMs: now - 5 * S }),
      live({ sessionId: 'r3', lastWriteMs: now - 9 * S }),
    ],
    history: [], totalSessions: 4, indexing: false, scope: 'all',
  };
  const ids = (rows: ReturnType<typeof stableOrder>) => rows.map(r => r.kind === 'link' ? r.action : r.sessionId);
  /** One render, as the webview does it: stamp the arrivals, then order the ACTIVE section. */
  const render = (prev: Arrivals | undefined, active: LiveRow[]) => {
    const arrivals = noteArrivals(prev, active);
    const rows = viewModel({ ...snap, active, totalSessions: active.length }, now, opts).sections[0]!.rows;
    return { arrivals, ids: ids(stableOrder(rows, arrivals)) };
  };

  it('reorders within a state group by arrival, newest first, and never across groups', () => {
    const rows = viewModel(snap, now, opts).sections[0]!.rows;
    // r1 arrived first, r3 most recently — the newest arrival goes on top, whatever the host's write order says
    const arrivals: Arrivals = { n: 9, at: { r3: { n: 3, group: 'running/' }, r2: { n: 2, group: 'running/' }, r1: { n: 1, group: 'running/' }, p: { n: 9, group: 'attention/tool-or-permission' } } };
    expect(ids(stableOrder(rows, arrivals))).toEqual(['p', 'r3', 'r2', 'r1']);
  });
  it('on first sight the rows take the host order', () => {
    expect(render(undefined, snap.active).ids).toEqual(['p', 'r1', 'r2', 'r3']);
  });
  it('a session that just wrote does not jump: it keeps its stamp while it stays in its group', () => {
    const first = render(undefined, snap.active);
    const swapped = [snap.active[0]!, { ...snap.active[3]!, lastWriteMs: now }, snap.active[1]!, snap.active[2]!];
    const next = render(first.arrivals, swapped);
    expect(next.ids).toEqual(first.ids);
    expect(next.arrivals).toEqual(first.arrivals);
  });
  it('a session that changes state enters its new group at the top, and again when it comes back', () => {
    const a = render(undefined, snap.active);
    const r3 = snap.active[3]!;
    // host order: r3 joins p's group, and was written more recently than p
    const b = render(a.arrivals, [{ ...r3, state: 'attention', reason: 'tool-or-permission' }, snap.active[0]!, snap.active[1]!, snap.active[2]!]);
    expect(b.ids).toEqual(['r3', 'p', 'r1', 'r2']);
    const c = render(b.arrivals, snap.active);
    expect(c.ids).toEqual(['p', 'r3', 'r1', 'r2']);
  });
  it('a session that leaves ACTIVE and comes back enters at the top, not at its old place', () => {
    const a = render(undefined, snap.active);
    expect(a.ids).toEqual(['p', 'r1', 'r2', 'r3']);
    const b = render(a.arrivals, [snap.active[0]!, snap.active[1]!, snap.active[2]!]);
    expect(b.arrivals.at).not.toHaveProperty('r3');
    expect(render(b.arrivals, snap.active).ids).toEqual(['p', 'r3', 'r1', 'r2']);
  });
  it('parked rows keep the host order — youngest first — whatever their stamps', () => {
    const parked = (id: string, ageH: number): LiveRow => live({ sessionId: id, state: 'attention', reason: 'your-turn', lastWriteMs: now - ageH * H, parked: true });
    const rows = [parked('p6', 6), parked('p20', 20), parked('p50', 50)];
    const arrivals: Arrivals = { n: 3, at: { p50: { n: 3, group: 'parked' }, p6: { n: 1, group: 'parked' }, p20: { n: 2, group: 'parked' } } };
    expect(ids(stableOrder(viewModel({ ...snap, active: rows }, now, opts).sections[0]!.rows, arrivals))).toEqual(['p6', 'p20', 'p50']);
  });
  it('regression: a new or resumed session is not listed under the tab-parked ones, and lands on top when it finishes', () => {
    const turn = { state: 'attention' as const, reason: 'your-turn' as const };
    const parked = (id: string, ageH: number): LiveRow => live({ sessionId: id, ...turn, lastWriteMs: now - ageH * H, parked: true });
    const running = (id: string): LiveRow => live({ sessionId: id, state: 'running', lastWriteMs: now });
    const done = (id: string, agoS: number): LiveRow => live({ sessionId: id, ...turn, lastWriteMs: now - agoS * S });
    // host order (buildSnapshot): fresh urgency groups, then parked youngest first
    const a = render(undefined, [parked('spreadsheet', 6), parked('stampd', 20), parked('pr', 50)]);
    const b = render(a.arrivals, [running('chrome'), parked('spreadsheet', 6), parked('stampd', 20), parked('pr', 50)]);
    expect(b.ids).toEqual(['chrome', 'spreadsheet', 'stampd', 'pr']);
    const c = render(b.arrivals, [running('stampd'), running('chrome'), parked('spreadsheet', 6), parked('pr', 50)]);
    expect(c.ids).toEqual(['stampd', 'chrome', 'spreadsheet', 'pr']);            // resumed after chrome started → above it
    const d = render(c.arrivals, [done('chrome', 5), running('stampd'), parked('spreadsheet', 6), parked('pr', 50)]);
    expect(d.ids).toEqual(['chrome', 'stampd', 'spreadsheet', 'pr']);
    const e = render(d.arrivals, [done('stampd', 1), done('chrome', 9), parked('spreadsheet', 6), parked('pr', 50)]);
    expect(e.ids).toEqual(['stampd', 'chrome', 'spreadsheet', 'pr']);            // finished last → on top
  });
  it('leaves link rows in place and keeps groups contiguous', () => {
    const rows = viewModel({ ...snap, history: [hist({ sessionId: 'h' })] }, now, opts).sections[1]!.rows;
    expect(ids(stableOrder(rows, noteArrivals(undefined, [])))).toEqual(['h', 'search', 'scope']);
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
                           history: [], totalSessions: 2, indexing: false, scope: 'all' }, now, { activeWindowLabel: '4h', searchKey: 'k', contextBudget: 200_000 });
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
    const vm = viewModel({ active: [old, live({ sessionId: 'a' })], history: [], totalSessions: 2, indexing: false, scope: 'all' }, now, opts);
    expect(vm.sections[0]!.rows[0]).toMatchObject({ sessionId: 'o', age: { label: '> 1d 2h', tier: 'stale' } });
    expect(vm.sections[0]!.rows[1]).not.toHaveProperty('age');
    expect(vm.sections[0]!.empty).toBeNull();
    expect(viewModel({ active: [], history: [], totalSessions: 0, indexing: false, scope: 'all' }, now, opts).sections[0]!.empty).toContain('open in a tab');
  });
});
