import { describe, it, expect } from 'vitest';
import { statusIcon, iconClasses, fmtTokens, nodeMeta, toolIcon, modelChip, listModel, threadLayout, railBounds, clampRail, railKey, tlBounds, clampTl, tlKey, validRail, validTlVh, findPaths, pathOfCode,
         parseInline, parseMarkdown, looksJson, recognise, defaultView, JSON_BIG, nowStep, plainLine } from '../src/webview/session/model.js';
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
