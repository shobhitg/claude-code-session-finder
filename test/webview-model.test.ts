import { describe, it, expect } from 'vitest';
import { fmtDuration, timeLabel, historyLabel, metaLabel, iconClass, viewModel, resultsModel } from '../src/webview/model.js';
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
    expect(fmtDuration(40 * S)).toBe('40 s');
    expect(fmtDuration(3 * M + 20 * S)).toBe('3 m');
    expect(fmtDuration(2.1 * H)).toBe('2.1 h');
    expect(fmtDuration(3 * H)).toBe('3 h');
    expect(fmtDuration(72 * H)).toBe('3 d');
    expect(fmtDuration(-5)).toBe('0 s');
  });
});

describe('timeLabel (spec §10 table)', () => {
  it('running: just now, then quiet N', () => {
    expect(timeLabel(live({ lastWriteMs: now - 10 * S }), now)).toBe('just now');
    expect(timeLabel(live({ lastWriteMs: now - 2 * M }), now)).toBe('quiet 2 m');
  });
  it('tool-or-permission says quiet; your-turn says done; a question asks; an interruption says so; stalled is bare', () => {
    expect(timeLabel(live({ state: 'attention', reason: 'tool-or-permission', lastWriteMs: now - 3 * M }), now)).toBe('quiet 3 m');
    expect(timeLabel(live({ state: 'attention', reason: 'your-turn', lastWriteMs: now - 3 * M }), now)).toBe('done · 3 m ago');
    expect(timeLabel(live({ state: 'attention', reason: 'question', lastWriteMs: now - 40 * S }), now)).toBe('asks you · 40 s');
    expect(timeLabel(live({ state: 'attention', reason: 'interrupted', lastWriteMs: now - 2 * M }), now)).toBe('interrupted · 2 m');
    expect(timeLabel(live({ state: 'attention', reason: 'stalled', lastWriteMs: now - 2.1 * H }), now)).toBe('2.1 h');
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

  it('builds ACTIVE and HISTORY with counts, states and the search-all link', () => {
    const vm = viewModel(snap, now, opts);
    expect(vm.sections.map(s => [s.id, s.label, s.count])).toEqual([['active', 'Active', 2], ['history', 'History', 38]]);
    const [active, history] = vm.sections;
    expect(active!.rows[0]).toMatchObject({ kind: 'session', sessionId: 'a', state: 'running', missing: false,
                                            iconClass: 'codicon codicon-loading codicon-modifier-spin' });
    expect(active!.rows[1]).toMatchObject({ kind: 'session', state: 'attention', reason: 'your-turn', missing: true,
                                            iconClass: 'codicon codicon-comment-discussion' });
    expect(history!.rows[0]).toMatchObject({ kind: 'session', sessionId: 'h', state: 'history', time: 'Sep 15 · 31 msgs' });
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
    expect(vm.sections[0]!.empty).toBe('Nothing running. Sessions touched in the last 4h appear here.');
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
