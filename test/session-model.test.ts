import { describe, it, expect } from 'vitest';
import { statusIcon, iconClasses, fmtTokens, nodeMeta, toolIcon, modelChip, listModel, threadLayout, findPaths, pathOfCode,
         parseInline, parseMarkdown, looksJson, recognise, defaultView, JSON_BIG } from '../src/webview/session/model.js';
import type { GraphNode, SessionGraph } from '../src/core/agents.js';

const T0 = Date.parse('2026-10-08T09:14:00');
const M = 60_000, H = 60 * M;
const node = (o: Partial<GraphNode>): GraphNode =>
  ({ id: 'x', kind: 'agent', parentId: 'session', label: 'x', background: false, status: 'completed', children: [], ...o });

describe('statusIcon / iconClasses / fmtTokens / toolIcon / modelChip', () => {
  it('maps status to a codicon, spinner unless motion is reduced', () => {
    expect(statusIcon('agent', 'running')).toBe('loading~spin');
    expect(statusIcon('agent', 'launched', true)).toBe('circle-large-filled');
    expect(statusIcon('agent', 'completed')).toBe('check');
    expect(statusIcon('workflow', 'completed')).toBe('type-hierarchy');
    expect(statusIcon('failed-spawn', 'failed')).toBe('error');
    expect(statusIcon('agent', 'stopped')).toBe('circle-slash');
    expect(iconClasses('loading~spin')).toBe('codicon codicon-loading codicon-modifier-spin');
  });
  it('formats tokens, picks tool icons, and tiers models so the chip deepens with the model', () => {
    expect(fmtTokens(950)).toBe('950'); expect(fmtTokens(64_607)).toBe('65k'); expect(fmtTokens(2_300_000)).toBe('2.3M');
    expect(toolIcon('Bash')).toBe('terminal'); expect(toolIcon('StructuredOutput')).toBe('json'); expect(toolIcon('Whatever')).toBe('tools');
    expect(modelChip('claude-haiku-4-5-20251001')).toEqual({ label: 'haiku', tier: 1 });
    expect(modelChip('claude-sonnet-5-5')).toEqual({ label: 'sonnet', tier: 2 });
    expect(modelChip('claude-opus-5-5')).toEqual({ label: 'opus', tier: 3 });
    expect(modelChip(undefined)).toBeUndefined();
  });
  it('nodeMeta describes running, finished and failed nodes', () => {
    expect(nodeMeta(node({ status: 'running', spawnTs: T0 - 90_000 }), T0)).toBe('running · 2m');
    expect(nodeMeta(node({ durationMs: 144_440, totalTokens: 64_607, toolUses: 22, model: 'claude-sonnet-5' }), T0)).toBe('2m · 65k tokens · 22 tools · sonnet-5');
    expect(nodeMeta(node({ kind: 'failed-spawn', status: 'failed' }), T0)).toBe('spawn failed');
  });
});

const graph = (): SessionGraph => ({ root: 'session', order: ['session', 'a', 'w', 'w1', 'w2', 'b', 'b1'], nodes: {
  session: node({ id: 'session', kind: 'session', parentId: null, status: 'running', spawnTs: T0, children: ['a', 'w', 'b'], spans: [[T0, T0 + 80 * M], [T0 + 15 * H, T0 + 15 * H + 30 * M]] }),
  a: node({ id: 'a', spawnTs: T0 + 2 * M, endTs: T0 + 6 * M }),
  w: node({ id: 'w', kind: 'workflow', spawnTs: T0 + 45 * M, endTs: T0 + 80 * M, children: ['w1', 'w2'] }),
  w1: node({ id: 'w1', parentId: 'w', spawnTs: T0 + 46 * M, endTs: T0 + 60 * M }),
  w2: node({ id: 'w2', parentId: 'w', status: 'failed', spawnTs: T0 + 47 * M, endTs: T0 + 55 * M }),
  b: node({ id: 'b', status: 'running', spawnTs: T0 + 15 * H, children: ['b1'] }),
  b1: node({ id: 'b1', parentId: 'b', status: 'running', spawnTs: T0 + 15 * H + 5 * M }),
} });

describe('listModel (D20)', () => {
  it('is the session, then each thing it started; a workflow is a group with its agents and their outcomes; nested agents stay under their parent', () => {
    const l = listModel(graph());
    expect(l.map(e => e.kind === 'row' ? `${e.id}@${e.depth}` : `group:${e.id}`)).toEqual(['session@0', 'a@0', 'group:w', 'b@0', 'b1@1']);
    const g = l[2]!; expect(g.kind === 'group' && g.rows.map(r => r.id)).toEqual(['w1', 'w2']);
    expect(g.kind === 'group' && g.counts).toEqual({ completed: 1, failed: 1 });
  });
});

describe('threadLayout (D20)', () => {
  const now = T0 + 15 * H + 30 * M;
  const L = threadLayout(graph(), now, { width: 1000, labelW: 200, lane: 18, top: 20, gapW: 50 });
  it('folds the idle stretch between bursts into one marked gap of fixed width', () => {
    expect(L.segs).toHaveLength(2);
    expect(L.gaps).toEqual([{ x: L.segs[0]!.x1, w: 50, idleMs: 15 * H - 80 * M }]);
    expect(L.segs[0]!.x0).toBe(200); expect(L.segs[1]!.x1).toBeCloseTo(988);
    expect(L.nowX).toBeCloseTo(988);                                   // the session is live: now is the right edge
  });
  it('gives each node a lane in graph order, with depth, and puts a thread where its parent started it', () => {
    expect(L.lanes.map(l => [l.id, l.depth])).toEqual([['session', 0], ['a', 1], ['w', 1], ['w1', 2], ['w2', 2], ['b', 1], ['b1', 2]]);
    const b = L.lanes.find(l => l.id === 'b')!, b1 = L.lanes.find(l => l.id === 'b1')!;
    expect(b.x0).toBeGreaterThan(L.gaps[0]!.x + 49);                   // after the gap
    expect(b1.x0).toBeGreaterThan(b.x0); expect(b1.open).toBe(true); expect(b1.parent).toBe('b');
    expect(L.lanes[1]!.y - L.lanes[0]!.y).toBe(18);
  });
  it('labels each stretch with its start (and its end when there is room), with the day once it spans midnight', () => {
    expect(L.ticks[0]).toEqual({ x: 200, label: 'Oct 8 09:14', anchor: 'start' });
    expect(L.ticks.some(t => t.label === 'Oct 9 00:14' && t.anchor === 'start')).toBe(true);
  });
  it('an empty graph lays out nothing', () => {
    expect(threadLayout({ root: 'session', order: ['session'], nodes: { session: node({ id: 'session', kind: 'session', parentId: null }) } }, now, { width: 500, labelW: 100, lane: 18, top: 20, gapW: 40 }).lanes).toEqual([]);
  });
});

describe('findPaths / pathOfCode (D20)', () => {
  it('finds absolute and relative file names with a line, and not URLs, API routes or plain words', () => {
    const t = 'see src/webhooks/rate-limit.ts:9 and /home/dev/shop/api/.worktrees/x/src/a.ts, not https://x.com/a/b.js or /api/autoflow-task/stream or node.js.';
    expect(findPaths(t).map(h => [h.path, h.line])).toEqual([['src/webhooks/rate-limit.ts', 9], ['/home/dev/shop/api/.worktrees/x/src/a.ts', undefined]]);
    expect(findPaths('folder /workspaces/aida/.worktrees/shobhit/x is gone.').map(h => h.path)).toEqual(['/workspaces/aida/.worktrees/shobhit/x']);
    expect(findPaths('the flame graph is in scratch/flamegraph.png.').map(h => h.raw)).toEqual(['scratch/flamegraph.png']);
    expect(findPaths('../lib/x.mjs and ./a/b.tsx').map(h => h.path)).toEqual(['../lib/x.mjs', './a/b.tsx']);
  });
  it('a code span that is only a file name is a file — bare names too, which plain text never links', () => {
    expect(pathOfCode('handler.ts')).toEqual({ path: 'handler.ts' });
    expect(pathOfCode('src/a.ts:12')).toEqual({ path: 'src/a.ts', line: 12 });
    expect(pathOfCode('npm run bench')).toBeUndefined();
    expect(findPaths('edit handler.ts now')).toEqual([]);
  });
});

describe('parseInline / parseMarkdown (D20)', () => {
  it('reads code, bold, links and file names; a link or code span naming a file is a file', () => {
    expect(parseInline('**Done.** Run `npm test` in [the guide](https://example.com/g) or open [rate-limit.ts](src/webhooks/rate-limit.ts#L9).')).toEqual([
      { t: 'strong', c: [{ t: 'text', v: 'Done.' }] }, { t: 'text', v: ' Run ' }, { t: 'code', v: 'npm test' }, { t: 'text', v: ' in ' },
      { t: 'link', href: 'https://example.com/g', c: [{ t: 'text', v: 'the guide' }] }, { t: 'text', v: ' or open ' },
      { t: 'path', label: 'rate-limit.ts', path: 'src/webhooks/rate-limit.ts', line: 9 }, { t: 'text', v: '.' }]);
  });
  it('lays out headings, lists, code, tables, tagged sections and the Insight block', () => {
    const md = ['You are reviewing **performance**.', '', '<context>', 'Branch `feat/x`.', '</context>', '', '## What to check',
      '1. Redis round-trips', '2. Allocations', '', '```ts', 'const a = 1;', '```', '', '| a | b |', '|---|---|', '| 1 | 2 |', '',
      '`★ Insight ─────────────────────`', '- one round-trip', '`─────────────────────────────`', '', 'Done.'].join('\n');
    expect(parseMarkdown(md).map(b => b.t)).toEqual(['p', 'tag', 'h', 'list', 'code', 'table', 'insight', 'p']);
    const b = parseMarkdown(md);
    expect(b[1]).toEqual({ t: 'tag', name: 'context', c: [{ t: 'p', c: [{ t: 'text', v: 'Branch ' }, { t: 'code', v: 'feat/x' }, { t: 'text', v: '.' }] }] });
    expect(b[3]).toMatchObject({ t: 'list', ordered: true, start: 1 });
    expect(b[4]).toEqual({ t: 'code', lang: 'ts', v: 'const a = 1;' });
    expect(b[5]).toMatchObject({ t: 'table', head: [[{ t: 'text', v: 'a' }], [{ t: 'text', v: 'b' }]] });
    expect(b[6]).toEqual({ t: 'insight', c: [{ t: 'list', ordered: false, start: 1, items: [[{ t: 'text', v: 'one round-trip' }]] }] });
  });
  it('keeps a paragraph\'s line breaks and an unclosed tag as text', () => {
    expect(parseMarkdown('line one\nline two')).toEqual([{ t: 'p', c: [{ t: 'text', v: 'line one\nline two' }] }]);
    expect(parseMarkdown('<summary>\nno close')[0]).toMatchObject({ t: 'p' });
  });
});

describe('JSON views (D20)', () => {
  it('looksJson is a cheap shape test before any parse', () => {
    expect(looksJson(' {"a":1} ')).toBe(true); expect(looksJson('[1,2]')).toBe(true); expect(looksJson('{ not json')).toBe(false); expect(looksJson('hello')).toBe(false);
  });
  it('recognises a verdict with findings', () => {
    expect(recognise({ verdict: 'ok', findings: [{ severity: 'minor', title: 't', file: 'a.ts', line: 3 }] })).toEqual({ verdict: 'ok', findings: [{ severity: 'minor', title: 't', file: 'a.ts', line: 3 }] });
    expect(recognise({ findings: [1, 2] })).toBeUndefined();
    expect(recognise([{ title: 'x' }])).toBeUndefined();
  });
  it('opens Formatted when known, else Pretty; what you chose for the tool sticks; the dump past JSON_BIG', () => {
    expect(defaultView(500, true, undefined)).toBe('formatted');
    expect(defaultView(500, false, undefined)).toBe('pretty');
    expect(defaultView(500, false, 'raw')).toBe('raw');
    expect(defaultView(500, false, 'formatted')).toBe('pretty');           // a choice this value cannot honour
    expect(defaultView(JSON_BIG + 1, true, 'formatted')).toBe('raw');
  });
});
