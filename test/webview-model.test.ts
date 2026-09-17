import { describe, it, expect } from 'vitest';
import { fmtDuration, timeLabel, historyLabel, metaLabel, iconClass, viewModel } from '../src/webview/model.js';
import type { Snapshot, LiveRow, HistoryRow } from '../src/core/rows.js';

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
  it('tool-or-permission says quiet; your-turn says ago; stalled is bare', () => {
    expect(timeLabel(live({ state: 'attention', reason: 'tool-or-permission', lastWriteMs: now - 3 * M }), now)).toBe('quiet 3 m');
    expect(timeLabel(live({ state: 'attention', reason: 'your-turn', lastWriteMs: now - 3 * M }), now)).toBe('3 m ago');
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
    totalSessions: 40, indexing: false,
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
    expect(history!.rows.at(-1)).toEqual({ kind: 'link', title: 'Search all 40 sessions…', meta: 'Ctrl+Alt+S',
                                            iconClass: 'codicon codicon-search', action: 'search' });
  });
  it('empty ACTIVE explains the window; indexing shows a skeleton and no link', () => {
    const vm = viewModel({ active: [], history: [], totalSessions: 0, indexing: true }, now, opts);
    expect(vm.sections[0]!.empty).toBe('Nothing running. Sessions touched in the last 4h appear here.');
    expect(vm.sections[1]!.skeleton).toBe(true);
    expect(vm.sections[1]!.rows).toEqual([]);
  });
  it('reduced motion swaps the spinner for a static dot', () => {
    const vm = viewModel(snap, now, { ...opts, reducedMotion: true });
    expect(vm.sections[0]!.rows[0]).toMatchObject({ iconClass: 'codicon codicon-circle-large-filled' });
  });
});
