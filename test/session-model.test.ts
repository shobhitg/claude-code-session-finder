import { describe, it, expect } from 'vitest';
import { statusIcon, iconClasses, fmtTokens, nodeMeta, toolIcon, modelChip, listModel, threadLayout, intervalWidth, TICK_CHAR_PX, railBounds, clampRail, railKey, tlBounds, clampTl, tlKey, validRail, validTlVh, findPaths, pathOfCode,
         parseInline, parseMarkdown, looksJson, recognise, defaultView, JSON_BIG, nowStep, plainLine } from '../src/webview/session/model.js';
import { fmtDuration } from '../src/webview/model.js';
import type { ThreadTick } from '../src/webview/session/model.js';
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
    expect(L.gaps).toEqual([{ x: L.segs[0]!.x1, w: 50, idleMs: 15 * H - 80 * M, label: `${fmtDuration(15 * H - 80 * M)} idle` }]);
    expect(L.segs[0]!.x0).toBe(200); expect(L.segs[1]!.x1).toBeLessThanOrEqual(988);
    expect(L.nowX).toBeCloseTo(L.segs[1]!.x1);                         // the session is live: now is where its last stretch ends
  });
  it('does not stretch a short session to fill the window — the axis grows to the right as work goes on', () => {
    expect(L.segs[1]!.x1).toBeLessThan(900);
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

describe('intervalWidth (D24)', () => {
  const w = (ms: number): number => intervalWidth(ms, 6, 56, 30_000);
  it('is the minimum for an instant, halfway after one half-life, and flattens against the maximum', () => {
    expect(w(0)).toBe(6);
    expect(w(30_000)).toBeCloseTo(31);
    expect(w(2 * M)).toBeCloseTo(52.875, 2);                           // a minute or two: already near the top
    expect(w(3 * H)).toBeCloseTo(56, 6);
  });
  it('never narrows as the wait grows, never passes the maximum, and the next hour adds nothing visible', () => {
    let last = -1;
    for (const ms of [0, 1, 500, 5_000, 30_000, 90_000, 5 * M, 20 * M, H, 10 * H, 100 * H]) { expect(w(ms)).toBeGreaterThanOrEqual(last); expect(w(ms)).toBeLessThanOrEqual(56); last = w(ms); }
    expect(w(2 * H) - w(H)).toBeLessThan(0.001);
  });
});

describe('threadLayout — a long wait does not crowd out the rest (D24)', () => {
  const o = { width: 1000, labelW: 200, lane: 18, top: 20, gapW: 50, minW: 6, maxW: 56, halfLifeMs: 30_000 };
  // one three-hour stretch: a 2-minute agent, a 160-minute one, a 1-second one and a 1-minute one
  const long = (): SessionGraph => ({ root: 'session', order: ['session', 'a', 'b', 'c', 'd'], nodes: {
    session: node({ id: 'session', kind: 'session', parentId: null, status: 'completed', spawnTs: T0, endTs: T0 + 3 * H, children: ['a', 'b', 'c', 'd'], spans: [[T0, T0 + 3 * H]] }),
    a: node({ id: 'a', spawnTs: T0 + M, endTs: T0 + 3 * M }),
    b: node({ id: 'b', spawnTs: T0 + 10 * M, endTs: T0 + 170 * M }),
    c: node({ id: 'c', spawnTs: T0 + 171 * M, endTs: T0 + 171 * M + 1000 }),
    d: node({ id: 'd', spawnTs: T0 + 175 * M, endTs: T0 + 176 * M }),
  } });
  const L = threadLayout(long(), T0 + 4 * H, o);
  const lane = (id: string) => L.lanes.find(l => l.id === id)!;
  const width = (id: string): number => lane(id).x1 - lane(id).x0;

  it('a bar that ran for hours is no wider than the maximum, and barely wider than one that ran for two minutes', () => {
    expect(width('b')).toBeLessThanOrEqual(56 + 1e-6);
    expect(width('b') / width('a')).toBeLessThan(1.2);                 // linear, it was 80 times wider
  });
  it('a short bar stays visible — a one-second agent is at least the minimum wide', () => {
    expect(width('c')).toBeGreaterThanOrEqual(6);
    expect(width('d')).toBeCloseTo(intervalWidth(M, 6, 56, 30_000));
  });
  it('a whole three-hour stretch with nine pieces is at most nine maxima wide', () => {
    expect(L.segs).toHaveLength(1);
    expect(L.segs[0]!.x1 - L.segs[0]!.x0).toBeLessThanOrEqual(9 * 56);
  });
  it('an instant still has the minimum width', () => {
    const g: SessionGraph = { root: 'session', order: ['session'], nodes: { session: node({ id: 'session', kind: 'session', parentId: null, status: 'completed', spawnTs: T0, endTs: T0, spans: [[T0, T0]] }) } };
    const I = threadLayout(g, T0 + M, o);
    expect(I.segs[0]!.x1 - I.segs[0]!.x0).toBeCloseTo(6);
  });

  const crowd = (n: number): SessionGraph => {
    const ids = Array.from({ length: n }, (_, i) => `n${i}`);
    return { root: 'session', order: ['session', ...ids], nodes: {
      session: node({ id: 'session', kind: 'session', parentId: null, status: 'completed', spawnTs: T0, endTs: T0 + n * 2 * M, children: ids, spans: [[T0, T0 + n * 2 * M]] }),
      ...Object.fromEntries(ids.map((id, i) => [id, node({ id, spawnTs: T0 + i * 2 * M, endTs: T0 + i * 2 * M + M })])),
    } };
  };
  it('a crowd of agents is squeezed to fit the window, not run off its edge', () => {
    const C = threadLayout(crowd(150), T0 + 400 * M, o);
    expect(C.segs[C.segs.length - 1]!.x1).toBeCloseTo(988);            // 1000 − the label column's 200 → 788 to share, 12 spare on the right
    for (const l of C.lanes) { expect(l.x0).toBeGreaterThanOrEqual(200); expect(l.x1).toBeLessThanOrEqual(988 + 1e-6); }
  });
  it('time still runs left to right: a node that started later never sits to the left, and a thread leaves a lane that is there', () => {
    for (const [name, G] of [['long', long()], ['crowd', crowd(150)], ['bursts', graph()]] as const) {
      const C = threadLayout(G, T0 + 16 * H, o);
      const byStart = [...C.lanes].sort((p, q) => p.start - q.start || p.end - q.end);
      byStart.forEach((l, i) => { if (i) expect(l.x0, `${name}: ${l.id}`).toBeGreaterThanOrEqual(byStart[i - 1]!.x0 - 1e-9); expect(l.x1, `${name}: ${l.id}`).toBeGreaterThanOrEqual(l.x0); });
      for (const l of C.lanes) { const p = l.parent && C.lanes.find(x => x.id === l.parent); if (p) { expect(l.x0, `${name}: ${l.id}`).toBeGreaterThanOrEqual(p.x0 - 1e-9); expect(l.x0, `${name}: ${l.id}`).toBeLessThanOrEqual(p.x1 + 1e-9); } }
    }
  });
});

describe('threadLayout — ticks never overlap (D24)', () => {
  // minW = maxW: every piece is exactly 60 px, so a stretch is as wide as it has pieces and the labels can be made to crowd on purpose
  const o = { width: 1000, labelW: 200, lane: 18, top: 20, gapW: 50, minW: 60, maxW: 60 };
  const extent = (t: ThreadTick): [number, number] => { const len = t.label.length * TICK_CHAR_PX; return t.anchor === 'start' ? [t.x, t.x + len] : [t.x - len, t.x]; };
  const D = 24 * H;
  // three stretches a day apart: A two pieces (Oct 8 09:14 – 09:16), B four pieces (Oct 9 05:14 – 05:18), C one piece (Oct 10 01:14)
  const threeStretches = (status: 'completed' | 'running' = 'completed'): SessionGraph => ({ root: 'session', order: ['session', 'p', 'q1', 'q2'], nodes: {
    session: node({ id: 'session', kind: 'session', parentId: null, status, spawnTs: T0, endTs: T0 + 2 * D - 8 * H + M, children: ['p', 'q1', 'q2'],
      spans: [[T0, T0 + 2 * M], [T0 + D - 4 * H, T0 + D - 4 * H + 4 * M], [T0 + 2 * D - 8 * H, T0 + 2 * D - 8 * H + M]] }),
    p: node({ id: 'p', spawnTs: T0 + M, endTs: T0 + 2 * M }),
    q1: node({ id: 'q1', spawnTs: T0 + D - 4 * H + M, endTs: T0 + D - 4 * H + 2 * M }),
    q2: node({ id: 'q2', spawnTs: T0 + D - 4 * H + 3 * M, endTs: T0 + D - 4 * H + 4 * M }),
  } });
  it('drops an end label that would land on its own start label, and keeps one with room', () => {
    const L = threadLayout(threeStretches(), T0 + 3 * D, o);
    expect(L.segs.map(s => Math.round(s.x1 - s.x0))).toEqual([120, 240, 60]);
    expect(L.ticks.map(t => [t.label, t.anchor])).toEqual([['Oct 8 09:14', 'start'], ['Oct 9 05:14', 'start'], ['Oct 9 05:18', 'end'], ['Oct 10 01:14', 'start']]);
    const ext = L.ticks.map(extent).sort((p, q) => p[0] - q[0]);
    ext.forEach((e, i) => { if (i) expect(e[0]).toBeGreaterThanOrEqual(ext[i - 1]![1]); });
  });
  it('a start label that would run off the right edge is moved left until it fits, not cut', () => {
    // two stretches in 420 px, the pieces squeezed to fit: the last ends 12 px short of the edge, but its label is 74 px long
    const g: SessionGraph = { root: 'session', order: ['session', 'p'], nodes: {
      session: node({ id: 'session', kind: 'session', parentId: null, status: 'completed', spawnTs: T0, endTs: T0 + 40 * H + M, children: ['p'], spans: [[T0, T0 + 2 * M], [T0 + 40 * H, T0 + 40 * H + M]] }),
      p: node({ id: 'p', spawnTs: T0 + M, endTs: T0 + 2 * M }) } };
    const L = threadLayout(g, T0 + 3 * D, { ...o, width: 420 });
    const c = L.ticks.find(t => t.label === 'Oct 10 01:14')!;
    expect(c.anchor).toBe('start'); expect(c.x).toBeLessThan(L.segs[1]!.x0);
    for (const t of L.ticks) { const e = extent(t); expect(e[0], t.label).toBeGreaterThanOrEqual(0); expect(e[1], t.label).toBeLessThanOrEqual(420); }
  });
  it('the now label gives way to a start label it would land on, and the dashed line stays', () => {
    // live, and resumed a piece ago: the last stretch's start label and "now" want the same 60 px
    const L = threadLayout(threeStretches('running'), T0 + 2 * D - 8 * H + M, o);
    expect(L.nowX).toBeCloseTo(L.segs[2]!.x1);
    expect(L.ticks.filter(t => t.now)).toEqual([]);
    expect(L.ticks.some(t => t.label === 'Oct 10 01:14' && t.anchor === 'start')).toBe(true);
  });
  it('shows "now" at the live edge when there is room for it', () => {
    const L = threadLayout(graph(), T0 + 15 * H + 30 * M, { ...o, minW: 6, maxW: 56, halfLifeMs: 30_000 });
    expect(L.ticks.filter(t => t.now)).toEqual([{ x: L.nowX, label: 'now', anchor: 'end', now: true }]);
  });
});

describe('threadLayout — idle gaps are thin dividers whose labels never touch (D24)', () => {
  // three one-piece stretches 14 h apart (13h 59m idle between each): minW = maxW sets how far apart the two gap labels sit
  const bursts = (): SessionGraph => ({ root: 'session', order: ['session'], nodes: { session: node({ id: 'session', kind: 'session', parentId: null, status: 'completed', spawnTs: T0, endTs: T0 + 28 * H + M,
    spans: [[T0, T0 + M], [T0 + 14 * H, T0 + 14 * H + M], [T0 + 28 * H, T0 + 28 * H + M]] }) } });
  const labels = (piece: number): Array<string | undefined> => threadLayout(bursts(), T0 + 29 * H, { width: 1000, labelW: 200, lane: 18, top: 20, gapW: 26, minW: piece, maxW: piece }).gaps.map(g => g.label);
  it('names each gap with how long it was idle, when there is room', () => {
    expect(labels(60)).toEqual(['13h 59m idle', '13h 59m idle']);
  });
  it('writes just the length when "idle" would touch the neighbouring label, and nothing when even that would', () => {
    expect(labels(44)).toEqual(['13h 59m idle', '13h 59m']);
    expect(labels(14)).toEqual(['13h 59m idle', undefined]);
  });
});

describe('the rail width (D23)', () => {
  it('stays between a narrow-but-usable minimum and what leaves the timeline and pane their room', () => {
    expect(railBounds(1400)).toEqual([140, 640]);
    expect(railBounds(750)).toEqual([140, 430]);                       // 750 − 320 for the column beside it
    expect(railBounds(400)).toEqual([140, 140]);                       // too narrow to resize at all
    expect(clampRail(50, 1400)).toBe(140); expect(clampRail(900, 1400)).toBe(640); expect(clampRail(251.6, 1400)).toBe(252);
    expect(clampRail(600, 750)).toBe(430);
  });
  it('moves with the arrow keys — 16 px, 64 with Shift — to the ends with Home and End, and ignores every other key', () => {
    expect(railKey('ArrowRight', 200, 1400, false)).toBe(216);
    expect(railKey('ArrowLeft', 200, 1400, false)).toBe(184);
    expect(railKey('ArrowRight', 200, 1400, true)).toBe(264);
    expect(railKey('ArrowLeft', 200, 1400, true)).toBe(140);          // 136, held at the minimum
    expect(railKey('Home', 300, 1400, false)).toBe(140);
    expect(railKey('End', 300, 750, false)).toBe(430);
    expect(railKey('a', 300, 1400, false)).toBeUndefined();
    expect(railKey('Enter', 300, 1400, false)).toBeUndefined();         // Enter resets; that is the view's business
    expect(railKey('ArrowUp', 300, 1400, false)).toBeUndefined();       // up and down are the timeline divider's
  });
});

describe('the timeline height (D23)', () => {
  it('stays between a couple of lanes and what leaves the pane its room', () => {
    expect(tlBounds(900)).toEqual([60, 660]);                          // 900 − the 40 px header − 200 px for the pane
    expect(tlBounds(500)).toEqual([60, 260]);
    expect(tlBounds(200)).toEqual([60, 60]);                           // too short to adjust
    expect(clampTl(10, 900)).toBe(60); expect(clampTl(2000, 900)).toBe(660); expect(clampTl(300.4, 900)).toBe(300);
  });
  it('moves with the up and down arrows — 16 px, 64 with Shift — to the ends with Home and End, and ignores every other key', () => {
    expect(tlKey('ArrowDown', 200, 900, false)).toBe(216);
    expect(tlKey('ArrowUp', 200, 900, false)).toBe(184);
    expect(tlKey('ArrowDown', 200, 900, true)).toBe(264);
    expect(tlKey('ArrowUp', 100, 900, true)).toBe(60);                 // 36, held at the minimum
    expect(tlKey('Home', 300, 900, false)).toBe(60);
    expect(tlKey('End', 300, 900, false)).toBe(660);
    expect(tlKey('ArrowLeft', 300, 900, false)).toBeUndefined();        // left and right are the rail divider's
    expect(tlKey('Enter', 300, 900, false)).toBeUndefined();
  });
});

describe('what the host will remember of the dividers (D23)', () => {
  it('accepts every size a divider can produce, at any window from a phone to an 8K screen — or the preference would silently not save on a tall one', () => {
    for (const W of [320, 480, 600, 750, 1100, 1400, 2560, 7680]) for (const px of railBounds(W)) expect(validRail(px), `rail ${px}px in ${W}px`).toBe(true);
    for (const H of [300, 500, 700, 900, 1300, 1440, 2160, 4320]) for (const px of tlBounds(H)) expect(validTlVh(px / H * 100), `timeline ${px}px in ${H}px`).toBe(true);
  });
  it('refuses what is not a size: NaN, Infinity, strings, null, zero and the absurd', () => {
    for (const v of [NaN, Infinity, -Infinity, '200', null, undefined, {}, 0, -5, 99, 5000]) expect(validRail(v), String(v)).toBe(false);
    for (const v of [NaN, Infinity, '40', null, undefined, 0, -1, 0.2, 100, 250]) expect(validTlVh(v), String(v)).toBe(false);
    expect(validRail(140)).toBe(true); expect(validTlVh(34)).toBe(true);
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

describe('the Now strip: the card, kept in view while the card is scrolled off', () => {
  const running = { ts: 5_000, tool: 'Bash', summary: 'Run the tests', status: 'running' as const };
  it('shows the call in flight the card shows: the node\'s own first, else the one the transcript still has open', () => {
    const own = { tool: 'Read', summary: 'handler.ts', since: 9_000 };
    expect(nowStep({ now: own }, { running })).toEqual(own);
    expect(nowStep({}, { running })).toEqual({ tool: 'Bash', summary: 'Run the tests', since: 5_000 });
    expect(nowStep({}, {})).toBeUndefined();                       // working: no tool in flight
  });
  it('says the latest words on one plain line: Markdown unwrapped, files and links by name, code blocks and tables left out', () => {
    expect(plainLine('Still rate-limited. **The hook** also says `src/a.ts` changed — see [the docs](https://x.dev/d).'))
      .toBe('Still rate-limited. The hook also says src/a.ts changed — see the docs.');
    expect(plainLine('## Plan\n\n- read the file\n- run the tests\n\n```sh\nnpm test\n```\n\nThen report.')).toBe('Plan read the file run the tests Then report.');
    expect(plainLine('> quoted\n\n| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe('quoted');
    expect(plainLine('  \n\n ')).toBe('');
  });
});
