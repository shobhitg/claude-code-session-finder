import { describe, it, expect } from 'vitest';
import { statusIcon, iconClasses, fmtTokens, nodeMeta, treeRows, layoutTimeline, toolIcon } from '../src/webview/session/model.js';
import type { GraphNode, SessionGraph, Bar } from '../src/core/agents.js';

const T0 = 1_000_000_000_000;
const node = (o: Partial<GraphNode>): GraphNode =>
  ({ id: 'x', kind: 'agent', parentId: 'session', label: 'x', background: false, status: 'completed', children: [], ...o });

describe('statusIcon / iconClasses / fmtTokens / toolIcon', () => {
  it('maps status to a codicon, spinner unless motion is reduced', () => {
    expect(statusIcon('agent', 'running')).toBe('loading~spin');
    expect(statusIcon('agent', 'launched', true)).toBe('circle-large-filled');
    expect(statusIcon('agent', 'completed')).toBe('check');
    expect(statusIcon('workflow', 'completed')).toBe('type-hierarchy');
    expect(statusIcon('failed-spawn', 'failed')).toBe('error');
    expect(statusIcon('agent', 'stopped')).toBe('circle-slash');
    expect(statusIcon('agent', 'unknown')).toBe('circle-large-outline');
    expect(iconClasses('loading~spin')).toBe('codicon codicon-loading codicon-modifier-spin');
  });
  it('formats tokens and picks tool icons', () => {
    expect(fmtTokens(950)).toBe('950'); expect(fmtTokens(64_607)).toBe('65k'); expect(fmtTokens(2_300_000)).toBe('2.3M');
    expect(toolIcon('Bash')).toBe('terminal'); expect(toolIcon('Whatever')).toBe('tools');
  });
});

describe('nodeMeta', () => {
  it('describes running, finished and failed nodes', () => {
    expect(nodeMeta(node({ status: 'running', spawnTs: T0 - 90_000 }), T0)).toBe('running · 2 m');
    expect(nodeMeta(node({ durationMs: 144_440, totalTokens: 64_607, toolUses: 22, model: 'claude-sonnet-5' }), T0)).toBe('2 m · 65k tokens · 22 tools · sonnet-5');
    expect(nodeMeta(node({ spawnTs: T0, endTs: T0 + 30_000, background: true }), T0)).toBe('30 s · background');
    expect(nodeMeta(node({ kind: 'failed-spawn', status: 'failed' }), T0)).toBe('spawn failed');
  });
});

describe('treeRows', () => {
  it('walks the graph order with depth', () => {
    const g: SessionGraph = { root: 'session', order: ['session', 'a', 'b', 'c'], nodes: {
      session: node({ id: 'session', kind: 'session', parentId: null, status: 'running', spawnTs: T0 - 1000, children: ['a', 'c'] }),
      a: node({ id: 'a', children: ['b'] }), b: node({ id: 'b', parentId: 'a' }), c: node({ id: 'c' }),
    } };
    expect(treeRows(g, T0).map(r => [r.id, r.depth, r.live])).toEqual([['session', 0, true], ['a', 1, false], ['b', 2, false], ['c', 1, false]]);
  });
});

describe('layoutTimeline', () => {
  const bar = (id: string, start: number, end: number | null, o: Partial<Bar> = {}): Bar =>
    ({ id, start, end, kind: 'agent', status: end === null ? 'running' : 'completed', label: id, depth: 1, ...o });

  it('packs non-overlapping bars into one lane and overlapping ones into more', () => {
    const l = layoutTimeline([bar('s', 0, 100, { kind: 'session', depth: 0 }), bar('a', 10, 40), bar('b', 20, 30), bar('c', 50, 60)], 100);
    const lane = (id: string) => l.placed.find(p => p.bar.id === id)!.lane;
    expect(lane('s')).toBe(0);                    // the session baseline keeps lane 0
    expect(lane('a')).toBe(1); expect(lane('b')).toBe(2); expect(lane('c')).toBe(1);
    expect(l.lanes).toBe(3);
  });
  it('spans first start to last end, extends open bars to now, and yields 6 ticks', () => {
    const l = layoutTimeline([bar('a', 1000, 2000), bar('b', 1500, null)], 3000);
    expect(l.start).toBe(1000); expect(l.end).toBe(3000);
    const b = l.placed.find(p => p.bar.id === 'b')!;
    expect(b.open).toBe(true); expect(b.x0).toBeCloseTo(0.25); expect(b.x1).toBeCloseTo(1);
    expect(l.ticks).toHaveLength(6); expect(l.ticks[0]!.x).toBe(0); expect(l.ticks[5]!.x).toBe(1);
  });
  it('a finished session does not stretch to now, and a zero-length bar still has width', () => {
    const l = layoutTimeline([bar('a', 1000, 2000), bar('b', 1200, 1200)], 99_999_999);
    expect(l.end).toBe(2000);
    const b = l.placed.find(p => p.bar.id === 'b')!;
    expect(b.x1 - b.x0).toBeGreaterThan(0);
  });
  it('is empty for no bars', () => {
    expect(layoutTimeline([], 5)).toEqual({ placed: [], lanes: 0, start: 5, end: 5, ticks: [] });
  });
});
