# Live Sessions — Stage 1 Implementation Plan (engine · status bar · Quick Pick icons → 0.2.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the status bar and the existing search Quick Pick, see which Claude Code sessions are running, which need you, and which are stalled — computed by observing transcript tails, with no hooks and no config writes — and stop Session Finder from silently resetting the user's Claude Code "preferred location".

**Architecture:** A `vscode`-free liveness engine in `src/core/` (`state.ts` classifies a 64 KB transcript tail; `live.ts` schedules stat sweeps and tail re-reads over injected fs/clock; `rows.ts` joins liveness with the existing index into a `Snapshot`; `open-args.ts` plans the exact `claude-vscode.editor.open` calls). A thin `src/live-host.ts` turns settings and window focus into a running tracker and emits snapshots to two surfaces: a new status bar item and state glyphs on the existing Quick Pick rows.

**Tech Stack:** TypeScript 5.x · Node 20 target · VS Code API ^1.94.0 · esbuild · vitest (unit) · @vscode/test-electron (manifest e2e)

**Spec:** `docs/live-sessions/design.md` — read §3 (findings L1–L13) and §7–§8 before starting. L3, L5, L7, L8, L9 and L10 each invalidate an otherwise-obvious implementation; the tasks below look pedantic because of them. `docs/design.md` (v0.1) remains the spec for everything this plan does not touch.

## Global Constraints

Every task's requirements implicitly include these. Values copied verbatim from the specs.

- **`src/core/**` MUST NOT import `vscode`.** Enforced by eslint `no-restricted-imports` (`.eslintrc.json`). New core files `state.ts`, `live.ts`, `rows.ts`, `open-args.ts` are under this rule.
- **The live path may only `stat`, and read a `65_536`-byte tail (widened once to `524_288`).** Never `readFile` a transcript from a tick or sweep (L9). Whole-file reads happen only inside `refreshIndex()`.
- **Skip every record whose `type` ∉ {`user`, `assistant`, `system`} and every record with `isSidechain === true`** when classifying (L3).
- **Thresholds and defaults:** `sessionFinder.activeWindow` = `"4h"`, `sessionFinder.toolQuietSeconds` = `60`, `sessionFinder.stalledMinutes` = `15`. Config prefix is `sessionFinder.`.
- **State resolution table (spec §7)** — `turn-ended` → attention/`your-turn`; `awaiting-tool` → running if quiet < `toolQuietMs` else attention/`tool-or-permission`; `awaiting-model` → running if quiet < `stalledMs` else attention/`stalled`; `unknown` → not in ACTIVE.
- **ACTIVE ordering:** `attention/tool-or-permission` → `attention/your-turn` → `running` → `attention/stalled`; then `lastWriteMs` descending.
- **`claude-vscode.editor.open` is always called with `prompt` (2nd arg) `undefined`** (F3) **and a 6th argument** `{ programmatic: true }` for a tab, or `{ programmatic: "honor-preferred-location" }` after `claude-vscode.sidebar.open` for the right panel (L10). Never call it without the 6th argument again.
- **Never build a folder URI with `Uri.file()`** (F8); **all path equality goes through `src/core/paths.ts`** (v0.1).
- **Every emitted `QuickPickItem` keeps `alwaysShow: true`** (F7).
- **`activationEvents` stays `["onStartupFinished"]`** (required by the hand-off, README "Why it activates at startup"; now also by the status bar). **`extensionDependencies` stays `["anthropic.claude-code"]`.**
- **`publisher` (`shobhitg`) and `name` (`claude-code-session-finder`) never change** (D1). Stage 1 does not rename `displayName` either — that is Stage 2, pending the spec's open question 1.
- **No telemetry, no network** (D10).
- **Timers never throw and never overlap** (spec §12): every timer callback goes through a guarded runner.
- Commit after every task with the message given; end each commit message with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Run `npm run typecheck && npm run lint && npm test` before every commit. All three must be clean.

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `src/core/query.ts` (modify) | `UNIT` gains `h`; new exported `durationMs(spec, fallbackMs)` | 1 |
| `test/window.test.ts` (create) | `durationMs` + `since:2h` | 1 |
| `src/core/state.ts` (create) | pure classifier: `classifyTail`, `resolveState`, `pickMainFile`, `effectiveMtime`, `readTail`, `readVerdict` | 2 |
| `test/state.test.ts` (create) | every verdict, both sides of both thresholds, L7/L8 file picking, tail truncation | 2 |
| `src/core/live.ts` (create) | `LivenessTracker` — sweep/tick scheduler over injected deps; publishes diffs | 3 |
| `test/live.test.ts` (create) | gating, changed-files-only reads, threshold crossing with no I/O, no-diff-no-emit, start/stop | 3 |
| `src/core/rows.ts` (create) | `buildSnapshot`, `projectLabel`, `stateIcon` | 4 |
| `test/rows.test.ts` (create) | ordering, exclusion, cap, title fallbacks, icons | 4 |
| `src/core/open-args.ts` (create) | `openCommands(sessionId, where)` | 5 |
| `test/open-args.test.ts` (create) | exact argument arrays | 5 |
| `src/open.ts` (modify) | `runOpen()`, `executePlan(plan, ctx, where)`, baton carries `where` | 5 |
| `src/extension.ts` (modify) | hand-off uses `runOpen`; wires `LiveHost`, status bar, `sessionFinder.showSessions` | 5, 6 |
| `src/live-host.ts` (create) | settings → tracker; focus pause; index cadence; `onSnapshot` | 6 |
| `src/surfaces/statusbar.ts` (create) | status bar item + tooltip | 6 |
| `package.json` (modify) | 3 configuration keys, `sessionFinder.showSessions` command | 6 |
| `src/surfaces/quickpick.ts` (modify) | state glyph on rows | 7 |
| `CHANGELOG.md`, `README.md`, `package.json` version (modify) | 0.2.0 release | 8 |

---

### Task 1: `durationMs` and the hour unit

**Files:**
- Modify: `src/core/query.ts:9-19` (the `UNIT` table and `windowToMs`)
- Test: `test/window.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function durationMs(spec: string, fallbackMs: number): number` — the duration a spec like `"4h"`, `"2d"`, `"1w"` denotes; `fallbackMs` when the spec is unparseable or `"all"`. `since:2h` now works in queries as a side effect.

- [ ] **Step 1: Write the failing test**

Create `test/window.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { durationMs, parseQuery } from '../src/core/query.js';

const H = 3_600_000, D = 24 * H;

describe('durationMs', () => {
  it('parses hours, days, weeks and months', () => {
    expect(durationMs('4h', 1)).toBe(4 * H);
    expect(durationMs('2d', 1)).toBe(2 * D);
    expect(durationMs('1w', 1)).toBe(7 * D);
    expect(durationMs('1m', 1)).toBe(30 * D);
    expect(durationMs('3', 1)).toBe(3 * D);            // bare number = days, as since: always has
  });
  it('falls back for "all", blanks and garbage', () => {
    expect(durationMs('all', 7)).toBe(7);
    expect(durationMs('', 7)).toBe(7);
    expect(durationMs('  4 hours ', 7)).toBe(7);
  });
});

describe('since: accepts hours', () => {
  it('since:2h narrows to two hours ago', () => {
    const now = 10 * D;
    expect(parseQuery('paste since:2h', '60d', now).sinceMs).toBe(now - 2 * H);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/window.test.ts`
Expected: FAIL — `durationMs` is not exported (`SyntaxError`/`TypeError: durationMs is not a function`).

- [ ] **Step 3: Implement**

In `src/core/query.ts`, replace the `DAY`/`UNIT` lines and `windowToMs` with:

```ts
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const UNIT: Record<string, number> = { h: HOUR, d: DAY, w: 7 * DAY, m: 30 * DAY };
const SPEC = /^(\d+)([hdwm])?$/;

/**
 * Duration a window spec denotes ("4h", "2d", "1w", bare digits = days), or `fallbackMs`
 * when the spec is unparseable or "all". Used for sessionFinder.activeWindow (spec L6).
 */
export function durationMs(spec: string, fallbackMs: number): number {
  const m = SPEC.exec(spec.trim().toLowerCase());
  if (!m) return fallbackMs;
  return Number(m[1]) * (UNIT[m[2] ?? 'd'] ?? DAY);
}

/** null = explicit "all time"; undefined = unparseable (caller should fall back) */
function windowToMs(spec: string, now: number): number | null | undefined {
  const s = spec.trim().toLowerCase();
  if (!s || s === 'all') return null;
  const m = SPEC.exec(s);
  if (!m) return undefined;
  return now - Number(m[1]) * (UNIT[m[2] ?? 'd'] ?? DAY);
}
```

Leave `resolveSince` and everything below it untouched.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/window.test.ts test/query.test.ts`
Expected: PASS — including every pre-existing `query.test.ts` case (the regex only *added* `h`).

- [ ] **Step 5: Commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/core/query.ts test/window.test.ts
git commit -m "feat(core): durationMs() and an hour unit for window specs

sessionFinder.activeWindow defaults to 4h (spec L6); since:2h works too.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The tail classifier (`core/state.ts`)

**Files:**
- Create: `src/core/state.ts`
- Test: `test/state.test.ts`

**Interfaces:**
- Consumes: `SourceFile` from `src/core/discover.ts` (`{ path, sessionId, projectDir, kind: 'session' | 'subagent', mtimeMs, size }`).
- Produces (all exported from `src/core/state.ts`):
  - `type TailVerdict = 'turn-ended' | 'awaiting-tool' | 'awaiting-model' | 'unknown'`
  - `type AttentionReason = 'tool-or-permission' | 'your-turn' | 'stalled'`
  - `type LiveState = { kind: 'running' } | { kind: 'attention'; reason: AttentionReason }`
  - `interface Thresholds { toolQuietMs: number; stalledMs: number }`, `const DEFAULT_THRESHOLDS: Thresholds` (`60_000`, `900_000`)
  - `interface Liveness { sessionId: string; verdict: TailVerdict; state: LiveState; lastWriteMs: number }`
  - `const TAIL_WINDOW = 65_536`, `const TAIL_WIDE = 524_288`
  - `classifyTail(text: string): TailVerdict`
  - `resolveState(verdict: TailVerdict, quietMs: number, t?: Thresholds): LiveState | null`
  - `pickMainFile(files: readonly SourceFile[]): SourceFile | undefined`
  - `effectiveMtime(files: readonly SourceFile[]): number`
  - `readTail(path: string, size: number, window?: number): Promise<string>`
  - `readVerdict(path: string, size: number, read?: typeof readTail): Promise<TailVerdict>`

- [ ] **Step 1: Write the failing tests**

Create `test/state.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  classifyTail, resolveState, pickMainFile, effectiveMtime, readTail, readVerdict,
  DEFAULT_THRESHOLDS, TAIL_WINDOW,
} from '../src/core/state.js';
import type { SourceFile } from '../src/core/discover.js';

const line = (o: unknown) => JSON.stringify(o);
const assistant = (stop_reason: string | null, extra: object = {}) =>
  line({ type: 'assistant', message: { stop_reason, content: [{ type: 'text', text: 'x' }] }, ...extra });
const user = (extra: object = {}) => line({ type: 'user', message: { content: 'go' }, ...extra });
const system = (subtype: string) => line({ type: 'system', subtype });
// The sidecars Claude Code appends AFTER conversational records (spec L3, §2 table).
const sidecars = [
  line({ type: 'last-prompt', prompt: 'x' }), line({ type: 'atis-latch' }), line({ type: 'mode', mode: 'auto' }),
  line({ type: 'cost-state' }), line({ type: 'pr-link', prNumber: 1 }), line({ type: 'ai-title', aiTitle: 't' }),
  line({ type: 'artifact-comment-monitor' }), line({ type: 'queue-operation', operation: 'x' }),
].join('\n');

describe('classifyTail', () => {
  it('skips sidecars and reads the last conversational record (L3)', () => {
    expect(classifyTail([assistant('end_turn'), sidecars].join('\n'))).toBe('turn-ended');
    expect(classifyTail([assistant('tool_use'), sidecars].join('\n'))).toBe('awaiting-tool');
    expect(classifyTail([user(), sidecars].join('\n'))).toBe('awaiting-model');
  });
  it('maps every verdict (L4, L5)', () => {
    expect(classifyTail(assistant('end_turn'))).toBe('turn-ended');
    expect(classifyTail(assistant('tool_use'))).toBe('awaiting-tool');
    expect(classifyTail(assistant(null))).toBe('awaiting-model');          // still streaming
    expect(classifyTail(assistant('max_tokens'))).toBe('awaiting-model');  // Claude Code continues
    expect(classifyTail(user())).toBe('awaiting-model');                    // prompt
    expect(classifyTail(line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } })))
      .toBe('awaiting-model');                                              // tool result
    expect(classifyTail(system('turn_duration'))).toBe('turn-ended');
    expect(classifyTail(system('away_summary'))).toBe('turn-ended');
    expect(classifyTail(system('local_command'))).toBe('turn-ended');
  });
  it('a system record that is not a turn boundary is skipped, not a verdict', () => {
    expect(classifyTail([assistant('tool_use'), system('compact_boundary')].join('\n'))).toBe('awaiting-tool');
  });
  it('skips sidechain records — a subagent finishing is not the main loop finishing', () => {
    expect(classifyTail([assistant('tool_use'), assistant('end_turn', { isSidechain: true })].join('\n')))
      .toBe('awaiting-tool');
  });
  it('skips a truncated last line (a write in progress) and blank lines', () => {
    expect(classifyTail([assistant('end_turn'), '{"type":"assistant","mess', ''].join('\n'))).toBe('turn-ended');
  });
  it('returns unknown when nothing conversational is present', () => {
    expect(classifyTail('')).toBe('unknown');
    expect(classifyTail(sidecars)).toBe('unknown');
  });
});

describe('resolveState (spec §7 table)', () => {
  const t = DEFAULT_THRESHOLDS;
  it('turn-ended is your turn regardless of quiet time', () => {
    expect(resolveState('turn-ended', 0, t)).toEqual({ kind: 'attention', reason: 'your-turn' });
    expect(resolveState('turn-ended', 10 * 3_600_000, t)).toEqual({ kind: 'attention', reason: 'your-turn' });
  });
  it('awaiting-tool flips at toolQuietMs', () => {
    expect(resolveState('awaiting-tool', t.toolQuietMs - 1, t)).toEqual({ kind: 'running' });
    expect(resolveState('awaiting-tool', t.toolQuietMs, t)).toEqual({ kind: 'attention', reason: 'tool-or-permission' });
  });
  it('awaiting-model stays running through a long generation and flips at stalledMs (L5)', () => {
    expect(resolveState('awaiting-model', 130_000, t)).toEqual({ kind: 'running' });   // the proof case
    expect(resolveState('awaiting-model', t.stalledMs - 1, t)).toEqual({ kind: 'running' });
    expect(resolveState('awaiting-model', t.stalledMs, t)).toEqual({ kind: 'attention', reason: 'stalled' });
  });
  it('unknown is not shown', () => {
    expect(resolveState('unknown', 0, t)).toBeNull();
  });
  it('honours custom thresholds', () => {
    expect(resolveState('awaiting-tool', 5_000, { toolQuietMs: 4_000, stalledMs: 1 }))
      .toEqual({ kind: 'attention', reason: 'tool-or-permission' });
  });
});

const sf = (o: Partial<SourceFile>): SourceFile =>
  ({ path: '/p/-w/a.jsonl', sessionId: 'a', projectDir: '-w', kind: 'session', mtimeMs: 1, size: 1, ...o });

describe('pickMainFile / effectiveMtime', () => {
  it('picks the newest MAIN copy; subagents never supply the verdict (L8)', () => {
    const files = [
      sf({ path: '/p/-w/a.jsonl', mtimeMs: 100 }),
      sf({ path: '/p/-w2/a.jsonl', mtimeMs: 300 }),                    // moved worktree: newer copy
      sf({ path: '/p/-w2/a/subagents/x.jsonl', kind: 'subagent', mtimeMs: 900 }),
    ];
    expect(pickMainFile(files)?.path).toBe('/p/-w2/a.jsonl');
  });
  it('returns undefined when only subagent files remain', () => {
    expect(pickMainFile([sf({ kind: 'subagent' })])).toBeUndefined();
  });
  it('effective mtime includes subagent activity (L7)', () => {
    expect(effectiveMtime([sf({ mtimeMs: 100 }), sf({ kind: 'subagent', mtimeMs: 900 })])).toBe(900);
    expect(effectiveMtime([])).toBe(0);
  });
});

describe('readTail / readVerdict', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'ccsf-state-')); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('returns the whole file when it fits the window', async () => {
    const f = join(dir, 'small.jsonl');
    const text = [assistant('end_turn'), sidecars].join('\n') + '\n';
    writeFileSync(f, text);
    expect(await readTail(f, statSync(f).size)).toBe(text);
  });
  it('drops the partial first line when the file is longer than the window (L9)', async () => {
    const f = join(dir, 'big.jsonl');
    const filler = line({ type: 'user', message: { content: 'z'.repeat(1000) } });
    const text = Array.from({ length: 80 }, () => filler).join('\n') + '\n' + assistant('tool_use') + '\n';
    writeFileSync(f, text);
    const size = statSync(f).size;
    expect(size).toBeGreaterThan(TAIL_WINDOW);
    const tail = await readTail(f, size);
    expect(tail.length).toBeLessThan(TAIL_WINDOW);
    expect(tail.startsWith('{')).toBe(true);                    // no half line at the top
    expect(classifyTail(tail)).toBe('awaiting-tool');
  });
  it('readVerdict widens once when the 64 KB window holds no conversational record', async () => {
    const f = join(dir, 'sidecar-heavy.jsonl');
    const sidecar = line({ type: 'artifact-autoreact-ledger', blob: 'y'.repeat(2000) });
    writeFileSync(f, assistant('end_turn') + '\n' + Array.from({ length: 40 }, () => sidecar).join('\n') + '\n');
    const size = statSync(f).size;
    expect(size).toBeGreaterThan(TAIL_WINDOW);
    const reads: number[] = [];
    const spy = (p: string, s: number, w?: number) => { reads.push(w ?? TAIL_WINDOW); return readTail(p, s, w); };
    expect(await readVerdict(f, size, spy)).toBe('turn-ended');
    expect(reads).toEqual([65_536, 524_288]);
  });
  it('an empty file is unknown without opening a read of zero bytes', async () => {
    const f = join(dir, 'empty.jsonl');
    writeFileSync(f, '');
    expect(await readVerdict(f, 0)).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/state.test.ts`
Expected: FAIL — `Cannot find module '../src/core/state.js'`.

- [ ] **Step 3: Implement `src/core/state.ts`**

```ts
import { open } from 'node:fs/promises';
import type { SourceFile } from './discover.js';

/** What the last conversational record says, independent of time (spec §6). */
export type TailVerdict =
  | 'turn-ended'      // assistant end_turn, or system turn_duration | away_summary | local_command
  | 'awaiting-tool'   // assistant tool_use — a tool is running OR a permission prompt is showing
  | 'awaiting-model'  // user (prompt or tool_result), or an assistant record that is still streaming
  | 'unknown';        // nothing conversational in the window

export type AttentionReason = 'tool-or-permission' | 'your-turn' | 'stalled';
export type LiveState = { kind: 'running' } | { kind: 'attention'; reason: AttentionReason };

export interface Thresholds { toolQuietMs: number; stalledMs: number }
export const DEFAULT_THRESHOLDS: Thresholds = { toolQuietMs: 60_000, stalledMs: 900_000 };

export interface Liveness {
  sessionId: string;
  verdict: TailVerdict;
  state: LiveState;
  /** max mtime over the main copy(ies) AND subagent files (L7) */
  lastWriteMs: number;
}

/**
 * L9: the live path never reads a whole transcript (0.7 GB corpus, 21.8 MB max). 64 KB covered
 * every session measured; widened once to 512 KB when the tail is all sidecars.
 */
export const TAIL_WINDOW = 65_536;
export const TAIL_WIDE = 524_288;

const CONVERSATIONAL = new Set(['user', 'assistant', 'system']);
/** system subtypes that end a turn. Others (e.g. compact_boundary) are not boundaries and are skipped. */
const TURN_BOUNDARY = new Set(['turn_duration', 'away_summary', 'local_command']);

interface Rec { type?: string; subtype?: string; isSidechain?: boolean; message?: { stop_reason?: string | null } }

function parse(line: string): Rec | null {
  try { return JSON.parse(line) as Rec; } catch { return null; }   // a write in progress is normal
}

/** L3: walk backwards past the sidecars to the last conversational record; L4/L5: read its verdict. */
export function classifyTail(text: string): TailVerdict {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    if (!raw || !raw.trim()) continue;
    const d = parse(raw);
    if (!d || !d.type || !CONVERSATIONAL.has(d.type) || d.isSidechain === true) continue;
    if (d.type === 'assistant') {
      const stop = d.message?.stop_reason;
      if (stop === 'end_turn') return 'turn-ended';
      if (stop === 'tool_use') return 'awaiting-tool';
      return 'awaiting-model';               // null (streaming), max_tokens, stop_sequence: the loop continues
    }
    if (d.type === 'system') {
      if (d.subtype && TURN_BOUNDARY.has(d.subtype)) return 'turn-ended';
      continue;
    }
    return 'awaiting-model';                 // user: a prompt or a tool_result the model has not answered
  }
  return 'unknown';
}

/** Spec §7 table. `null` = not shown in ACTIVE. `turn-ended` ignores quiet time on purpose. */
export function resolveState(
  verdict: TailVerdict, quietMs: number, t: Thresholds = DEFAULT_THRESHOLDS,
): LiveState | null {
  switch (verdict) {
    case 'turn-ended':     return { kind: 'attention', reason: 'your-turn' };
    case 'awaiting-tool':  return quietMs < t.toolQuietMs ? { kind: 'running' } : { kind: 'attention', reason: 'tool-or-permission' };
    case 'awaiting-model': return quietMs < t.stalledMs   ? { kind: 'running' } : { kind: 'attention', reason: 'stalled' };
    case 'unknown':        return null;
  }
}

/** L8: the verdict comes from the most recently written MAIN copy; subagents never supply it. */
export function pickMainFile(files: readonly SourceFile[]): SourceFile | undefined {
  let best: SourceFile | undefined;
  for (const f of files) if (f.kind === 'session' && (!best || f.mtimeMs > best.mtimeMs)) best = f;
  return best;
}

/** L7: a running subagent keeps its parent alive even though the main file is untouched. */
export function effectiveMtime(files: readonly SourceFile[]): number {
  let m = 0;
  for (const f of files) if (f.mtimeMs > m) m = f.mtimeMs;
  return m;
}

/**
 * The last `window` bytes of a file. When the file is longer than the window the first line is
 * (almost always) cut in half, so it is dropped; the caller only needs the records after it.
 */
export async function readTail(path: string, size: number, window: number = TAIL_WINDOW): Promise<string> {
  const len = Math.min(window, size);
  if (len === 0) return '';
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, size - len);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    if (size <= window) return text;
    const nl = text.indexOf('\n');
    return nl < 0 ? '' : text.slice(nl + 1);
  } finally {
    await fh.close();
  }
}

/** Tail → verdict, widening once (spec §7 `unknown` row). `read` is injectable for tests. */
export async function readVerdict(path: string, size: number, read: typeof readTail = readTail): Promise<TailVerdict> {
  let v = classifyTail(await read(path, size, TAIL_WINDOW));
  if (v === 'unknown' && size > TAIL_WINDOW) v = classifyTail(await read(path, size, TAIL_WIDE));
  return v;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/state.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Lint the vscode-free rule and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean (the eslint override for `src/core/**` accepts `node:fs/promises`; it only forbids `vscode`).

```bash
git add src/core/state.ts test/state.test.ts
git commit -m "feat(core): classify a session's state from its transcript tail

classifyTail skips Claude Code's sidecar records and reads the last
conversational one: assistant end_turn is 'your turn', tool_use is a tool or
a permission prompt, a user record means the model is generating (spec L3-L5).
readTail seeks to the last 64 KB; nothing in the live path reads whole files (L9).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The scheduler (`core/live.ts`)

**Files:**
- Create: `src/core/live.ts`
- Test: `test/live.test.ts`

**Interfaces:**
- Consumes: `discover`, `defaultRoot`, `SourceFile` (discover.ts); `readVerdict`, `effectiveMtime`, `pickMainFile`, `resolveState`, `Liveness`, `TailVerdict`, `Thresholds`, `DEFAULT_THRESHOLDS` (state.ts, Task 2).
- Produces (exported from `src/core/live.ts`):
  - `interface TrackerDeps { discover(root): Promise<SourceFile[]>; stat(path): Promise<{ mtimeMs: number; size: number }>; readVerdict(path, size): Promise<TailVerdict>; now(): number }`
  - `interface TrackerOptions { root?: string; activeWindowMs: number; thresholds?: Thresholds; sweepMs?: number; tickMs?: number }`
  - `type LivenessMap = ReadonlyMap<string, Liveness>`
  - `interface Change { liveness: LivenessMap; membershipChanged: boolean }`
  - `class LivenessTracker { constructor(opts, deps?); readonly liveness: LivenessMap; onChange(cb): () => void; sweep(): Promise<void>; tick(): Promise<void>; start(): void; stop(): void; onError?: (err: unknown) => void }`

- [ ] **Step 1: Write the failing tests**

Create `test/live.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { LivenessTracker, type TrackerDeps, type Change } from '../src/core/live.js';
import type { SourceFile } from '../src/core/discover.js';
import type { TailVerdict } from '../src/core/state.js';

const MIN = 60_000, H = 60 * MIN;

/** An in-memory corpus: the tracker only ever sees it through the injected deps. */
function harness(files: SourceFile[], verdicts: Record<string, TailVerdict>, start = 100 * H) {
  let clock = start;
  const reads: string[] = [];
  const deps: TrackerDeps = {
    discover: async () => files.map(f => ({ ...f })),
    stat: async p => {
      const f = files.find(x => x.path === p);
      if (!f) throw new Error('ENOENT');
      return { mtimeMs: f.mtimeMs, size: f.size };
    },
    readVerdict: async p => { reads.push(p); return verdicts[p] ?? 'unknown'; },
    now: () => clock,
  };
  const changes: Change[] = [];
  const tracker = new LivenessTracker({ activeWindowMs: 4 * H }, deps);
  tracker.onChange(c => changes.push(c));
  return { tracker, reads, changes, advance: (ms: number) => { clock += ms; }, now: () => clock, files };
}

const main = (id: string, mtimeMs: number, dir = '-w'): SourceFile =>
  ({ path: `/p/${dir}/${id}.jsonl`, sessionId: id, projectDir: dir, kind: 'session', mtimeMs, size: 10 });
const sub = (id: string, mtimeMs: number, dir = '-w'): SourceFile =>
  ({ path: `/p/${dir}/${id}/subagents/x.jsonl`, sessionId: id, projectDir: dir, kind: 'subagent', mtimeMs, size: 10 });

afterEach(() => { vi.useRealTimers(); });   // block body: useRealTimers() returns VitestUtils, and afterEach wants void

describe('LivenessTracker.sweep', () => {
  it('gates ACTIVE by the window (L6) and resolves state from the tail', async () => {
    const t0 = 100 * H;
    // 30 s quiet, not 60: exactly toolQuietMs is already "attention" (the threshold is ≥, spec §7).
    const h = harness([main('fresh', t0 - 30_000), main('old', t0 - 5 * H)], { '/p/-w/fresh.jsonl': 'awaiting-tool' }, t0);
    await h.tracker.sweep();
    expect([...h.tracker.liveness.keys()]).toEqual(['fresh']);
    expect(h.tracker.liveness.get('fresh')!.state).toEqual({ kind: 'running' });
    expect(h.reads).toEqual(['/p/-w/fresh.jsonl']);            // the old one was never read (L9)
    expect(h.changes).toHaveLength(1);
    expect(h.changes[0]!.membershipChanged).toBe(true);
  });

  it('a newer subagent keeps a session ACTIVE and supplies lastWriteMs, not the verdict (L7, L8)', async () => {
    const t0 = 100 * H;
    const h = harness([main('a', t0 - 6 * H), sub('a', t0 - 2 * MIN)], { '/p/-w/a.jsonl': 'awaiting-tool' }, t0);
    await h.tracker.sweep();
    const l = h.tracker.liveness.get('a')!;
    expect(l.lastWriteMs).toBe(t0 - 2 * MIN);
    expect(l.verdict).toBe('awaiting-tool');
    expect(h.reads).toEqual(['/p/-w/a.jsonl']);                // never the subagent file
  });

  it('reads the tail of the most recently written main copy after a worktree move (L8)', async () => {
    const t0 = 100 * H;
    const h = harness([main('a', t0 - 3 * H, '-w'), main('a', t0 - MIN, '-w2')],
                      { '/p/-w/a.jsonl': 'turn-ended', '/p/-w2/a.jsonl': 'awaiting-model' }, t0);
    await h.tracker.sweep();
    expect(h.reads).toEqual(['/p/-w2/a.jsonl']);
    expect(h.tracker.liveness.get('a')!.verdict).toBe('awaiting-model');
  });

  it('drops a session whose verdict is unknown and one that only has subagent files left', async () => {
    const t0 = 100 * H;
    const h = harness([main('u', t0), sub('orphan', t0)], {}, t0);
    await h.tracker.sweep();
    expect(h.tracker.liveness.size).toBe(0);
  });
});

describe('LivenessTracker.tick', () => {
  it('re-reads only files whose (mtime, size) changed', async () => {
    const t0 = 100 * H;
    const files = [main('a', t0 - MIN), main('b', t0 - MIN)];
    const h = harness(files, { '/p/-w/a.jsonl': 'awaiting-tool', '/p/-w/b.jsonl': 'awaiting-tool' }, t0);
    await h.tracker.sweep();
    expect(h.reads).toHaveLength(2);
    await h.tracker.tick();
    expect(h.reads).toHaveLength(2);                            // nothing changed, nothing read
    files[0]!.mtimeMs = t0; files[0]!.size = 11;               // 'a' appended
    await h.tracker.tick();
    expect(h.reads).toEqual(['/p/-w/a.jsonl', '/p/-w/b.jsonl', '/p/-w/a.jsonl']);
  });

  it('a threshold crossing fires onChange with no I/O (spec §8)', async () => {
    const t0 = 100 * H;
    const h = harness([main('a', t0 - 30_000)], { '/p/-w/a.jsonl': 'awaiting-tool' }, t0);
    await h.tracker.sweep();
    expect(h.tracker.liveness.get('a')!.state).toEqual({ kind: 'running' });
    h.advance(40_000);                                          // quiet is now 70 s
    await h.tracker.tick();
    expect(h.reads).toHaveLength(1);
    expect(h.tracker.liveness.get('a')!.state).toEqual({ kind: 'attention', reason: 'tool-or-permission' });
    expect(h.changes).toHaveLength(2);
    expect(h.changes[1]!.membershipChanged).toBe(false);
  });

  it('does not emit when nothing changed', async () => {
    const t0 = 100 * H;
    const h = harness([main('a', t0 - MIN)], { '/p/-w/a.jsonl': 'turn-ended' }, t0);
    await h.tracker.sweep();
    await h.tracker.tick();
    h.advance(1_000);
    await h.tracker.tick();
    expect(h.changes).toHaveLength(1);
  });

  it('a file that vanished mid-tick is dropped for that cycle, not thrown', async () => {
    const t0 = 100 * H;
    const files = [main('a', t0 - MIN)];
    const h = harness(files, { '/p/-w/a.jsonl': 'turn-ended' }, t0);
    await h.tracker.sweep();
    files.splice(0, 1);                                         // stat now rejects with ENOENT
    await expect(h.tracker.tick()).resolves.toBeUndefined();
    expect(h.tracker.liveness.size).toBe(0);
  });
});

describe('LivenessTracker.start/stop', () => {
  it('runs a sweep+tick immediately, then on its intervals; stop() cancels', async () => {
    vi.useFakeTimers({ now: 100 * H });
    const t0 = 100 * H;
    const h = harness([main('a', t0 - MIN)], { '/p/-w/a.jsonl': 'awaiting-tool' }, t0);
    const sweep = vi.spyOn(h.tracker, 'sweep');
    const tick = vi.spyOn(h.tracker, 'tick');
    h.tracker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);                  // 5 ticks + 1 sweep elapsed
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(5);
    h.tracker.stop();
    const after = tick.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick.mock.calls.length).toBe(after);
  });

  it('routes a throwing phase to onError instead of an unhandled rejection', async () => {
    vi.useFakeTimers({ now: 100 * H });
    const deps: TrackerDeps = {
      discover: async () => { throw new Error('boom'); },
      stat: async () => ({ mtimeMs: 0, size: 0 }), readVerdict: async () => 'unknown', now: () => 100 * H,
    };
    const tracker = new LivenessTracker({ activeWindowMs: H }, deps);
    const errors: unknown[] = [];
    tracker.onError = e => errors.push(e);
    tracker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveLength(1);
    tracker.stop();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/live.test.ts`
Expected: FAIL — `Cannot find module '../src/core/live.js'`.

- [ ] **Step 3: Implement `src/core/live.ts`**

```ts
import { stat as fsStat } from 'node:fs/promises';
import { discover as fsDiscover, defaultRoot, type SourceFile } from './discover.js';
import {
  readVerdict as fsReadVerdict, effectiveMtime, pickMainFile, resolveState,
  DEFAULT_THRESHOLDS, type Liveness, type TailVerdict, type Thresholds,
} from './state.js';

export interface TrackerDeps {
  discover: (root: string) => Promise<SourceFile[]>;
  stat: (path: string) => Promise<{ mtimeMs: number; size: number }>;
  readVerdict: (path: string, size: number) => Promise<TailVerdict>;
  now: () => number;
}

export interface TrackerOptions {
  root?: string;
  /** L6: sessions written within this window are ACTIVE and carry a state. */
  activeWindowMs: number;
  thresholds?: Thresholds;
  sweepMs?: number;
  tickMs?: number;
}

export type LivenessMap = ReadonlyMap<string, Liveness>;
export interface Change { liveness: LivenessMap; membershipChanged: boolean }

interface Tracked {
  sessionId: string;
  files: SourceFile[];
  main: SourceFile;
  /** `${mtimeMs}:${size}` of `main` when its tail was last read — the same key cache.ts uses. */
  key: string;
  verdict: TailVerdict;
}

const keyOf = (f: { mtimeMs: number; size: number }) => `${f.mtimeMs}:${f.size}`;

/**
 * Spec §8. Two phases over an in-memory picture of the ACTIVE set:
 *   sweep  — discover() everything (readdir + stat), recompute membership, read tails of NEW members
 *   tick   — re-stat ACTIVE files, re-read only tails whose (mtime, size) changed, re-resolve all
 * Publishes only when the resulting map differs (membership, verdict, state, reason, lastWriteMs).
 * No `vscode`, no real clock: everything comes through `deps`, so tests drive it deterministically.
 */
export class LivenessTracker {
  private tracked = new Map<string, Tracked>();
  private current = new Map<string, Liveness>();
  private readonly listeners = new Set<(c: Change) => void>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private readonly root: string;
  private readonly thresholds: Thresholds;
  private readonly sweepMs: number;
  private readonly tickMs: number;

  /** Spec §12: a timer callback never throws. Whatever a phase throws lands here (or is dropped). */
  onError: ((err: unknown) => void) | undefined;

  constructor(private readonly opts: TrackerOptions, private readonly deps: TrackerDeps = defaultDeps()) {
    this.root = opts.root ?? defaultRoot();
    this.thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
    this.sweepMs = opts.sweepMs ?? 10_000;
    this.tickMs = opts.tickMs ?? 2_000;
  }

  get liveness(): LivenessMap { return this.current; }

  onChange(cb: (c: Change) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  async sweep(): Promise<void> {
    const files = await this.deps.discover(this.root);
    const bySession = new Map<string, SourceFile[]>();
    for (const f of files) {
      const group = bySession.get(f.sessionId) ?? [];
      group.push(f);
      bySession.set(f.sessionId, group);
    }
    const now = this.deps.now();
    const next = new Map<string, Tracked>();
    for (const [sessionId, group] of bySession) {
      if (now - effectiveMtime(group) > this.opts.activeWindowMs) continue;          // L6, L7
      const main = pickMainFile(group);                                              // L8
      if (!main) continue;                                                           // parent transcript gone
      const key = keyOf(main);
      const prev = this.tracked.get(sessionId);
      const verdict = prev && prev.key === key && prev.main.path === main.path
        ? prev.verdict
        : await this.deps.readVerdict(main.path, main.size);
      next.set(sessionId, { sessionId, files: group, main, key, verdict });
    }
    const membershipChanged = next.size !== this.tracked.size || [...next.keys()].some(k => !this.tracked.has(k));
    this.tracked = next;
    this.publish(membershipChanged);
  }

  async tick(): Promise<void> {
    for (const [sessionId, t] of this.tracked) {
      const fresh: SourceFile[] = [];
      for (const f of t.files) {
        const s = await this.deps.stat(f.path).catch(() => null);                    // §12: vanished → skip
        if (s) fresh.push({ ...f, mtimeMs: s.mtimeMs, size: s.size });
      }
      const main = pickMainFile(fresh);
      if (!main) { this.tracked.delete(sessionId); continue; }
      t.files = fresh;
      const key = keyOf(main);
      if (key !== t.key || main.path !== t.main.path) {                              // changed → one tail read
        t.verdict = await this.deps.readVerdict(main.path, main.size);
        t.key = key;
        t.main = main;
      }
    }
    this.publish(false);
  }

  start(): void {
    this.stop();
    void this.run(async () => { await this.sweep(); await this.tick(); });
    this.sweepTimer = setInterval(() => void this.run(() => this.sweep()), this.sweepMs);
    this.tickTimer = setInterval(() => void this.run(() => this.tick()), this.tickMs);
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.sweepTimer = this.tickTimer = undefined;
  }

  private publish(membershipChanged: boolean): void {
    const now = this.deps.now();
    const next = new Map<string, Liveness>();
    for (const t of this.tracked.values()) {
      const lastWriteMs = effectiveMtime(t.files);
      const state = resolveState(t.verdict, now - lastWriteMs, this.thresholds);
      if (!state) continue;                                                          // unknown → not ACTIVE
      next.set(t.sessionId, { sessionId: t.sessionId, verdict: t.verdict, state, lastWriteMs });
    }
    const changed = membershipChanged || !sameLiveness(this.current, next);
    this.current = next;
    if (changed) for (const cb of this.listeners) cb({ liveness: next, membershipChanged });
  }

  /** Phases never overlap (a slow sweep skips the ticks under it) and never throw out of a timer. */
  private async run(phase: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try { await phase(); } catch (err) { this.onError?.(err); } finally { this.busy = false; }
  }
}

function sameLiveness(a: ReadonlyMap<string, Liveness>, b: ReadonlyMap<string, Liveness>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, x] of a) {
    const y = b.get(k);
    if (!y || x.verdict !== y.verdict || x.lastWriteMs !== y.lastWriteMs || x.state.kind !== y.state.kind) return false;
    if (x.state.kind === 'attention' && y.state.kind === 'attention' && x.state.reason !== y.state.reason) return false;
  }
  return true;
}

function defaultDeps(): TrackerDeps {
  return {
    discover: fsDiscover,
    stat: async p => { const s = await fsStat(p); return { mtimeMs: s.mtimeMs, size: s.size }; },
    readVerdict: fsReadVerdict,
    now: () => Date.now(),
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/live.test.ts test/state.test.ts`
Expected: PASS (10 new tests). If `start/stop` is flaky, check that `vi.useFakeTimers({ now })` runs **before** `harness()` — the harness's `now` is independent of the fake clock and only the intervals are faked.

- [ ] **Step 5: Commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/core/live.ts test/live.test.ts
git commit -m "feat(core): LivenessTracker — stat sweeps and changed-tail reads over the ACTIVE set

Sweep every 10 s recomputes membership from effective mtime (main + subagent
files); tick every 2 s re-stats ACTIVE files and re-reads only tails whose
(mtime, size) changed. Publishes only on a real diff. Phases never overlap
or throw out of a timer (spec §8, §12).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Snapshot rows (`core/rows.ts`)

**Files:**
- Create: `src/core/rows.ts`
- Test: `test/rows.test.ts`

**Interfaces:**
- Consumes: `SearchIndex`, `SessionMeta` (types.ts); `Liveness`, `AttentionReason` (state.ts).
- Produces (exported from `src/core/rows.ts`):
  - `interface LiveRow { sessionId; title; project; branch: string | null; pr: number | null; cwdExists: boolean; state: 'running' | 'attention'; reason?: AttentionReason; lastWriteMs: number }`
  - `interface HistoryRow { sessionId; title; project; branch; pr; cwdExists; lastTs: number; msgCount: number }`
  - `interface Snapshot { active: LiveRow[]; history: HistoryRow[]; totalSessions: number; indexing: boolean }`
  - `buildSnapshot(index: SearchIndex | null, liveness: ReadonlyMap<string, Liveness>, opts?: { historyLimit?: number; indexing?: boolean }): Snapshot`
  - `projectLabel(projectDir: string): string`
  - `stateIcon(row: { state: 'running' | 'attention'; reason?: AttentionReason }): string` — a codicon *name* (`loading~spin`, `bell-dot`, `comment-discussion`, `warning`); surfaces wrap it in `$(…)` or a CSS class.

- [ ] **Step 1: Write the failing tests**

Create `test/rows.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildSnapshot, projectLabel, stateIcon } from '../src/core/rows.js';
import type { SearchIndex, SessionMeta } from '../src/core/types.js';
import type { Liveness } from '../src/core/state.js';

const meta = (o: Partial<SessionMeta>): SessionMeta => ({
  sessionId: 'x', file: '/p/x.jsonl', extraFiles: [], projectDir: '-workspaces-aida', cwd: '/w', cwdExists: true,
  title: null, branches: [], prLinks: [], firstTs: 1, lastTs: 1, msgCount: 0, mtimeMs: 1, size: 1, ...o,
});
const live = (sessionId: string, state: Liveness['state'], lastWriteMs: number): [string, Liveness] =>
  [sessionId, { sessionId, verdict: 'awaiting-tool', state, lastWriteMs }];

const index: SearchIndex = {
  v: 1, builtAt: 0,
  sessions: [
    meta({ sessionId: 'a', title: 'Ledger GUI', branches: ['main', 'shobhit/ledger'], prLinks: [20231], lastTs: 900 }),
    meta({ sessionId: 'b', title: 'Deal forecast', lastTs: 800 }),
    meta({ sessionId: 'c', title: null, lastTs: 700, projectDir: '-workspaces-aida--claude-worktrees-figma' }),
    meta({ sessionId: 'd', title: 'Old one', lastTs: 100, cwdExists: false }),
  ],
  // prose is positional on sessions[]; c has a user prompt and an earlier assistant line
  prose: [{ s: 2, r: 'a', t: 1, x: 'hello' }, { s: 2, r: 'u', t: 2, x: 'Match the Figma frame for the sequences dialog' }],
};

describe('projectLabel', () => {
  it('is the last -- segment of the sanitized dir name, as the Quick Pick has always shown', () => {
    expect(projectLabel('-workspaces-aida')).toBe('workspaces-aida');
    expect(projectLabel('-workspaces-aida--claude-worktrees-figma')).toBe('claude-worktrees-figma');
  });
});

describe('stateIcon', () => {
  it('maps each state to a codicon name', () => {
    expect(stateIcon({ state: 'running' })).toBe('loading~spin');
    expect(stateIcon({ state: 'attention', reason: 'tool-or-permission' })).toBe('bell-dot');
    expect(stateIcon({ state: 'attention', reason: 'your-turn' })).toBe('comment-discussion');
    expect(stateIcon({ state: 'attention', reason: 'stalled' })).toBe('warning');
  });
});

describe('buildSnapshot', () => {
  it('orders ACTIVE by urgency then recency (spec §6)', () => {
    const liveness = new Map<string, Liveness>([
      live('a', { kind: 'running' }, 50),
      live('b', { kind: 'attention', reason: 'stalled' }, 99),
      live('c', { kind: 'attention', reason: 'your-turn' }, 10),
      live('d', { kind: 'attention', reason: 'tool-or-permission' }, 1),
      live('e', { kind: 'attention', reason: 'your-turn' }, 20),
    ]);
    const s = buildSnapshot(index, liveness);
    expect(s.active.map(r => r.sessionId)).toEqual(['d', 'e', 'c', 'a', 'b']);
  });

  it('joins index metadata onto live rows', () => {
    const s = buildSnapshot(index, new Map([live('a', { kind: 'running' }, 5)]));
    expect(s.active[0]).toMatchObject({
      sessionId: 'a', title: 'Ledger GUI', project: 'workspaces-aida', branch: 'shobhit/ledger', pr: 20231,
      cwdExists: true, state: 'running', lastWriteMs: 5,
    });
    expect(s.active[0]!.reason).toBeUndefined();
    const t = buildSnapshot(index, new Map([live('d', { kind: 'attention', reason: 'stalled' }, 5)]));
    expect(t.active[0]).toMatchObject({ reason: 'stalled', cwdExists: false });
  });

  it('falls back to the first user prompt, then to the id prefix, for a title', () => {
    const s = buildSnapshot(index, new Map([live('c', { kind: 'running' }, 5), live('zzzz-not-indexed-1234', { kind: 'running' }, 4)]));
    expect(s.active[0]!.title).toBe('Match the Figma frame for the sequences dialog');
    expect(s.active[1]!.title).toBe('zzzz-not');
    expect(s.active[1]!.project).toBe('');
  });

  it('HISTORY excludes ACTIVE ids, sorts by lastTs desc and caps at the limit', () => {
    const s = buildSnapshot(index, new Map([live('a', { kind: 'running' }, 5)]), { historyLimit: 2 });
    expect(s.history.map(r => r.sessionId)).toEqual(['b', 'c']);
    expect(s.history[0]).toMatchObject({ title: 'Deal forecast', lastTs: 800, msgCount: 0, cwdExists: true });
    expect(s.totalSessions).toBe(4);
  });

  it('works before the index exists and carries the indexing flag', () => {
    const s = buildSnapshot(null, new Map([live('a', { kind: 'running' }, 5)]), { indexing: true });
    expect(s.active[0]!.title).toBe('a');
    expect(s.history).toEqual([]);
    expect(s.totalSessions).toBe(0);
    expect(s.indexing).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/rows.test.ts`
Expected: FAIL — `Cannot find module '../src/core/rows.js'`.

- [ ] **Step 3: Implement `src/core/rows.ts`**

```ts
import type { SearchIndex, SessionMeta } from './types.js';
import type { Liveness, AttentionReason } from './state.js';

export interface LiveRow {
  sessionId: string; title: string; project: string; branch: string | null; pr: number | null;
  cwdExists: boolean;
  state: 'running' | 'attention'; reason?: AttentionReason;
  /** surfaces render "quiet 2 m" from this and their own clock */
  lastWriteMs: number;
}
export interface HistoryRow {
  sessionId: string; title: string; project: string; branch: string | null; pr: number | null;
  cwdExists: boolean; lastTs: number; msgCount: number;
}
export interface Snapshot { active: LiveRow[]; history: HistoryRow[]; totalSessions: number; indexing: boolean }

/** The derivation quickpick.ts has used since v0.1: last `--` segment of the sanitized dir name. */
export function projectLabel(projectDir: string): string {
  return projectDir.replace(/^-/, '').split('--').pop() ?? '';
}

/** Codicon NAME per state (spec §10 table). Surfaces wrap it: `$(name)` or `codicon-name`. */
export function stateIcon(row: { state: 'running' | 'attention'; reason?: AttentionReason }): string {
  if (row.state === 'running') return 'loading~spin';
  switch (row.reason) {
    case 'tool-or-permission': return 'bell-dot';
    case 'your-turn': return 'comment-discussion';
    default: return 'warning';
  }
}

/** Spec §6 ordering: things that need you, then things that are working, then things probably dead. */
const RANK: Record<string, number> = {
  'attention/tool-or-permission': 0, 'attention/your-turn': 1, running: 2, 'attention/stalled': 3,
};
const rank = (l: Liveness) =>
  RANK[l.state.kind === 'attention' ? `attention/${l.state.reason}` : 'running'] ?? 9;

function titleOf(m: SessionMeta | undefined, sessionId: string, firstPrompt: Map<string, string>): string {
  return m?.title ?? firstPrompt.get(sessionId)?.slice(0, 80) ?? sessionId.slice(0, 8);
}

export function buildSnapshot(
  index: SearchIndex | null,
  liveness: ReadonlyMap<string, Liveness>,
  opts: { historyLimit?: number; indexing?: boolean } = {},
): Snapshot {
  const limit = opts.historyLimit ?? 50;
  const byId = new Map<string, SessionMeta>();
  const firstPrompt = new Map<string, string>();
  if (index) {
    for (const s of index.sessions) byId.set(s.sessionId, s);
    for (const p of index.prose) {                       // file order, so the first 'u' per session is the first prompt
      if (p.r !== 'u') continue;
      const id = index.sessions[p.s]?.sessionId;
      if (id && !firstPrompt.has(id)) firstPrompt.set(id, p.x);
    }
  }

  const active: LiveRow[] = [...liveness.values()]
    .sort((a, b) => rank(a) - rank(b) || b.lastWriteMs - a.lastWriteMs)
    .map(l => {
      const m = byId.get(l.sessionId);
      const row: LiveRow = {
        sessionId: l.sessionId, title: titleOf(m, l.sessionId, firstPrompt),
        project: m ? projectLabel(m.projectDir) : '',
        branch: m?.branches.at(-1) ?? null, pr: m?.prLinks.at(-1) ?? null, cwdExists: m?.cwdExists ?? true,
        state: l.state.kind, lastWriteMs: l.lastWriteMs,
      };
      if (l.state.kind === 'attention') row.reason = l.state.reason;
      return row;
    });

  const history: HistoryRow[] = (index?.sessions ?? [])
    .filter(s => !liveness.has(s.sessionId))
    .sort((a, b) => b.lastTs - a.lastTs)
    .slice(0, limit)
    .map(m => ({
      sessionId: m.sessionId, title: titleOf(m, m.sessionId, firstPrompt), project: projectLabel(m.projectDir),
      branch: m.branches.at(-1) ?? null, pr: m.prLinks.at(-1) ?? null, cwdExists: m.cwdExists,
      lastTs: m.lastTs, msgCount: m.msgCount,
    }));

  return { active, history, totalSessions: index?.sessions.length ?? 0, indexing: opts.indexing ?? false };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/rows.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/core/rows.ts test/rows.test.ts
git commit -m "feat(core): buildSnapshot joins liveness with the index into ACTIVE and HISTORY rows

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Plan the open calls, and stop resetting the user's preferred location (L10)

**Files:**
- Create: `src/core/open-args.ts`
- Test: `test/open-args.test.ts`
- Modify: `src/open.ts` (the `here` branch of `executePlan`, the baton write; add `runOpen`)
- Modify: `src/extension.ts:11-20` (`openSession` in `tryClaimPendingOpen`)

**Interfaces:**
- Produces (exported from `src/core/open-args.ts`): `type OpenWhere = 'tab' | 'right'`; `interface CommandCall { command: string; args: unknown[] }`; `openCommands(sessionId: string, where?: OpenWhere): CommandCall[]`.
- Produces (exported from `src/open.ts`): `runOpen(sessionId: string, where: OpenWhere): Promise<void>`; `executePlan(plan: OpenPlan, ctx: vscode.ExtensionContext, where?: OpenWhere): Promise<void>` (third parameter is new, default `'tab'`).

- [ ] **Step 1: Write the failing test**

Create `test/open-args.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openCommands } from '../src/core/open-args.js';

describe('openCommands (spec L10, F3)', () => {
  it('opens in a tab with the programmatic flag in the SIXTH argument and no prompt', () => {
    expect(openCommands('sid-1', 'tab')).toEqual([
      { command: 'claude-vscode.editor.open',
        args: ['sid-1', undefined, undefined, undefined, undefined, { programmatic: true }] },
    ]);
    expect(openCommands('sid-1')).toEqual(openCommands('sid-1', 'tab'));
  });
  it('opens in the right panel by setting the preferred location first, then honouring it', () => {
    expect(openCommands('sid-1', 'right')).toEqual([
      { command: 'claude-vscode.sidebar.open', args: [] },
      { command: 'claude-vscode.editor.open',
        args: ['sid-1', undefined, undefined, undefined, undefined, { programmatic: 'honor-preferred-location' }] },
    ]);
  });
  it('never passes a prompt (F3) — argument 2 is undefined in every call', () => {
    for (const where of ['tab', 'right'] as const)
      for (const c of openCommands('sid-1', where))
        if (c.command === 'claude-vscode.editor.open') expect(c.args[1]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/open-args.test.ts`
Expected: FAIL — `Cannot find module '../src/core/open-args.js'`.

- [ ] **Step 3: Implement `src/core/open-args.ts`**

```ts
export type OpenWhere = 'tab' | 'right';
export interface CommandCall { command: string; args: unknown[] }

const EDITOR_OPEN = 'claude-vscode.editor.open';
const SIDEBAR_OPEN = 'claude-vscode.sidebar.open';

/**
 * L10 — Claude Code's routing, de-minified:
 *   route({ programmatic, preferredLocation, sessionAlreadyOpenInPanel, fullEditor }) {
 *     if (programmatic) return { target: programmatic === "honor-preferred-location" && preferredLocation === "sidebar"
 *                                         && !sessionAlreadyOpenInPanel ? "sidebar" : "panel",
 *                                 updatePreferredLocationToPanel: false };
 *     return { target: "panel", updatePreferredLocationToPanel: !fullEditor };     // ← what v0.1 triggered
 *   }
 * The sixth argument to editor.open is `options` and `options.programmatic` is what keeps Claude Code
 * from rewriting the user's preferred location. Older versions ignore the argument, so it is safe.
 * F3: `prompt` (argument 2) is always undefined — a prompt on an already-open session shows a toast.
 */
export function openCommands(sessionId: string, where: OpenWhere = 'tab'): CommandCall[] {
  const editorOpen = (programmatic: true | 'honor-preferred-location'): CommandCall =>
    ({ command: EDITOR_OPEN, args: [sessionId, undefined, undefined, undefined, undefined, { programmatic }] });
  if (where === 'right') {
    // sidebar.open sets the preferred location to "sidebar" (persistent, user-visible); the second
    // call then honours it. Two calls because there is no per-call target in Claude Code's API.
    return [{ command: SIDEBAR_OPEN, args: [] }, editorOpen('honor-preferred-location')];
  }
  return [editorOpen(true)];
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/open-args.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Route `open.ts` through `openCommands`**

In `src/open.ts`, add the import and a `runOpen` helper, and change `executePlan`:

```ts
import { openCommands, type OpenWhere } from './core/open-args.js';
```

Add after `openTranscript`:

```ts
/** The only place that calls into Claude Code to open a session. L10: never call editor.open directly. */
export async function runOpen(sessionId: string, where: OpenWhere): Promise<void> {
  for (const c of openCommands(sessionId, where)) await vscode.commands.executeCommand(c.command, ...c.args);
}
```

Change the signature and the `here` branch:

```ts
export async function executePlan(plan: OpenPlan, ctx: vscode.ExtensionContext, where: OpenWhere = 'tab'): Promise<void> {
```

```ts
    // F3: reveal-if-open / new-tab-otherwise is Claude Code's own behaviour.
    // L10: openCommands() passes the programmatic flag; without it every open here silently
    // reset the user's Claude Code preferred location to "panel".
    try {
      await runOpen(plan.sessionId, where);
    } catch {
```

And in the handoff branch, include `where` in the baton so the target window (Stage 2) can honour it:

```ts
    await writeFile(batonPath(ctx), JSON.stringify({
      sessionId: plan.sessionId, targetCwd: plan.targetCwd, expiresAt: Date.now() + BATON_TTL_MS, where,
    }));
```

- [ ] **Step 6: Route the hand-off claim through `runOpen`**

In `src/extension.ts`, replace the import of `BATON_FILE, batonPath` with:

```ts
import { BATON_FILE, batonPath, runOpen } from './open.js';
```

and the `openSession` callback body:

```ts
    openSession: async id => {
      try {
        await runOpen(id, 'tab');                    // Stage 2 reads baton.where; until then a hand-off opens a tab
      } catch {
        vscode.window.showErrorMessage('Claude Code did not accept the handed-off session.');
      }
    },
```

- [ ] **Step 7: Verify nothing else calls `editor.open` directly, then commit**

Run: `grep -rn "claude-vscode.editor.open" src/ | grep -v "core/open-args.ts"`
Expected: no output — the string exists only in `core/open-args.ts`.

```bash
npm run typecheck && npm run lint && npm test
git add src/core/open-args.ts test/open-args.test.ts src/open.ts src/extension.ts
git commit -m "fix: stop resetting the user's Claude Code preferred location on every open

editor.open without its 6th argument is a non-programmatic call, and Claude
Code answers that with updatePreferredLocationToPanel: true. openCommands()
now plans every call with { programmatic: true } (tab) or sidebar.open +
{ programmatic: 'honor-preferred-location' } (right panel); open.ts and the
hand-off claim both go through it. (spec L10)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `LiveHost`, the status bar, and the settings

**Files:**
- Create: `src/live-host.ts`
- Create: `src/surfaces/statusbar.ts`
- Modify: `src/extension.ts` (activate: create the host and the status bar; register `sessionFinder.showSessions`)
- Modify: `package.json` (`contributes.commands`, `contributes.configuration.properties`)

**Interfaces:**
- Consumes: `LivenessTracker`, `Change` (live.ts); `refreshIndex` (cache.ts); `durationMs` (query.ts); `buildSnapshot`, `Snapshot`, `stateIcon` (rows.ts); `Liveness` (state.ts).
- Produces:
  - `class LiveHost implements vscode.Disposable { constructor(ctx, log: vscode.LogOutputChannel); snapshot: Snapshot; readonly onSnapshot: vscode.Event<Snapshot>; readonly liveness: ReadonlyMap<string, Liveness>; refreshIndex(): Promise<void>; dispose(): void }` in `src/live-host.ts`
  - `createStatusBar(ctx): { update(s: Snapshot): void }` and `const SHOW_SESSIONS = 'sessionFinder.showSessions'` in `src/surfaces/statusbar.ts`
  - `mdEscape(s: string): string` in `src/surfaces/statusbar.ts` (exported for the test)
- These two files import `vscode`, so they are **not** unit-tested; their logic is kept to wiring and the pure parts are in core. `mdEscape` is the one pure helper and is tested.

- [ ] **Step 1: Write the failing test for the pure helper**

Create `test/statusbar-escape.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mdEscape } from '../src/surfaces/statusbar-escape.js';

describe('mdEscape', () => {
  it('neutralises markdown syntax in session titles without touching plain text', () => {
    expect(mdEscape('plain title')).toBe('plain title');
    expect(mdEscape('fix *bold* and [link](x) and `code` and #1 and a_b')).toBe(
      'fix \\*bold\\* and \\[link\\]\\(x\\) and \\`code\\` and \\#1 and a\\_b');
    expect(mdEscape('$(loading~spin) stays')).toBe('$\\(loading~spin\\) stays');   // no theme-icon injection from a title
  });
});
```

(The helper lives in its own `vscode`-free file, `src/surfaces/statusbar-escape.ts`, so vitest can import it — `surfaces/` is not under the core eslint rule, but importing `vscode` there would make the test unrunnable.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/statusbar-escape.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `src/surfaces/statusbar-escape.ts`:

```ts
/**
 * Titles are user/AI text; escape markdown so a title cannot format — or theme-icon — the tooltip.
 * The set is deliberately broad (it includes `.`, `-`, `+`): VS Code's renderer shows `\.` as `.`,
 * so over-escaping is invisible, while under-escaping lets "v0.2.0 - *fix*" italicise the tooltip.
 */
export function mdEscape(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, m => `\\${m}`);
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/statusbar-escape.test.ts`
Expected: PASS.

- [ ] **Step 5: Create `src/surfaces/statusbar.ts`**

```ts
import * as vscode from 'vscode';
import { stateIcon, type Snapshot } from '../core/rows.js';
import { mdEscape } from './statusbar-escape.js';

export const SHOW_SESSIONS = 'sessionFinder.showSessions';

/**
 * Spec §9.2: "$(loading~spin) 1  $(bell-dot) 3" — running count, attention count; a zero
 * count omits its segment; hidden when ACTIVE is empty. Click runs SHOW_SESSIONS.
 */
export function createStatusBar(ctx: vscode.ExtensionContext): { update(s: Snapshot): void } {
  const item = vscode.window.createStatusBarItem('sessionFinder.live', vscode.StatusBarAlignment.Left, 50);
  item.name = 'Claude Code Sessions';
  item.command = SHOW_SESSIONS;
  ctx.subscriptions.push(item);

  return {
    update(s: Snapshot) {
      if (s.active.length === 0) { item.hide(); return; }
      const running = s.active.filter(r => r.state === 'running').length;
      const attention = s.active.length - running;
      const parts: string[] = [];
      if (running) parts.push(`$(loading~spin) ${running}`);
      if (attention) parts.push(`$(bell-dot) ${attention}`);
      item.text = parts.join('  ');

      const md = new vscode.MarkdownString(undefined, true);       // supportThemeIcons for the $(…) glyphs
      md.isTrusted = false;
      md.appendMarkdown('**Claude Code sessions**\n\n');
      for (const r of s.active) {
        const meta = [r.project, r.branch].filter(Boolean).join(' · ');
        md.appendMarkdown(`- $(${stateIcon(r)}) ${mdEscape(r.title)}${meta ? `  —  ${mdEscape(meta)}` : ''}\n`);
      }
      md.appendMarkdown(`\n_${running} running · ${attention} need you · click to open the session list_`);
      item.tooltip = md;
      item.show();
    },
  };
}
```

- [ ] **Step 6: Create `src/live-host.ts`**

```ts
import * as vscode from 'vscode';
import { join } from 'node:path';
import { LivenessTracker } from './core/live.js';
import { refreshIndex } from './core/cache.js';
import { durationMs } from './core/query.js';
import { buildSnapshot, type Snapshot } from './core/rows.js';
import type { SearchIndex } from './core/types.js';
import type { Liveness } from './core/state.js';

const HOUR = 3_600_000;

/**
 * The vscode-aware owner of live state (spec D4, D6). Turns settings into a LivenessTracker,
 * pauses it while the window is unfocused, refreshes the search index only when ACTIVE
 * membership changes (L9), and emits a Snapshot for every surface to render.
 */
export class LiveHost implements vscode.Disposable {
  private tracker: LivenessTracker | undefined;
  private unsubscribe: (() => void) | undefined;
  private index: SearchIndex | null = null;
  private indexing: Promise<void> | null = null;
  private readonly emitter = new vscode.EventEmitter<Snapshot>();
  private readonly disposables: vscode.Disposable[] = [this.emitter];

  readonly onSnapshot: vscode.Event<Snapshot> = this.emitter.event;
  snapshot: Snapshot = { active: [], history: [], totalSessions: 0, indexing: true };

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly log: vscode.LogOutputChannel) {
    this.rebuildTracker();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('sessionFinder')) this.rebuildTracker();
      }),
      // D6: nothing runs while the window is unfocused; the first focus event sweeps at once.
      vscode.window.onDidChangeWindowState(s => (s.focused ? this.tracker?.start() : this.tracker?.stop())),
    );
    void this.refreshIndex();
  }

  get liveness(): ReadonlyMap<string, Liveness> { return this.tracker?.liveness ?? new Map(); }

  private rebuildTracker(): void {
    this.tracker?.stop();
    this.unsubscribe?.();
    const c = vscode.workspace.getConfiguration('sessionFinder');
    const tracker = new LivenessTracker({
      activeWindowMs: durationMs(c.get<string>('activeWindow', '4h'), 4 * HOUR),
      thresholds: {
        toolQuietMs: Math.max(5, c.get<number>('toolQuietSeconds', 60)) * 1_000,
        stalledMs: Math.max(1, c.get<number>('stalledMinutes', 15)) * 60_000,
      },
    });
    tracker.onError = err => this.log.warn(`live tracker: ${String(err)}`);
    this.unsubscribe = tracker.onChange(({ membershipChanged }) => {
      if (membershipChanged) void this.refreshIndex();          // a session appeared or left (D6)
      this.publish();
    });
    this.tracker = tracker;
    if (vscode.window.state.focused) tracker.start();
  }

  /** Whole-file work (L9) — never from a tick. Concurrent callers share one run. */
  refreshIndex(): Promise<void> {
    if (this.indexing) return this.indexing;
    this.indexing = (async () => {
      try {
        ({ index: this.index } = await refreshIndex({ cacheFile: join(this.ctx.globalStorageUri.fsPath, 'index.json') }));
      } catch (err) {
        this.log.warn(`index refresh failed: ${String(err)}`);
      } finally {
        this.indexing = null;
        this.publish();
      }
    })();
    return this.indexing;
  }

  private publish(): void {
    this.snapshot = buildSnapshot(this.index, this.liveness, { indexing: this.indexing !== null });
    this.emitter.fire(this.snapshot);
  }

  dispose(): void {
    this.tracker?.stop();
    this.unsubscribe?.();
    for (const d of this.disposables) d.dispose();
  }
}
```

- [ ] **Step 7: Wire it in `src/extension.ts`**

Add imports:

```ts
import { LiveHost } from './live-host.js';
import { createStatusBar, SHOW_SESSIONS } from './surfaces/statusbar.js';
```

Inside `activate`, after the existing `registerCommand('sessionFinder.search', …)` push, add:

```ts
  // Stage 1 (spec §9.2): the status bar is the glanceable answer to "which sessions are running?".
  const log = vscode.window.createOutputChannel('Claude Code Sessions', { log: true });
  const host = new LiveHost(ctx, log);
  const status = createStatusBar(ctx);
  ctx.subscriptions.push(log, host, host.onSnapshot(s => status.update(s)));
  // Until the sidebar browser exists (Stage 2) the session list IS the Quick Pick.
  ctx.subscriptions.push(vscode.commands.registerCommand(SHOW_SESSIONS, () => showSearchQuickPick(ctx, host.liveness)));
```

Task 7 gives `showSearchQuickPick` its second parameter and changes the existing `sessionFinder.search` registration to pass `host.liveness`. Tasks 6 and 7 are one commit (Task 7 Step 6), so the intermediate typecheck failure in Step 9 below is expected.

- [ ] **Step 8: Contribute the settings and the command in `package.json`**

Add to `contributes.commands`:

```json
{
  "command": "sessionFinder.showSessions",
  "title": "Claude: Show Sessions"
}
```

Add to `contributes.configuration.properties` (keep `sessionFinder.defaultWindow` as is):

```json
"sessionFinder.activeWindow": {
  "type": "string",
  "default": "4h",
  "pattern": "^\\s*\\d+\\s*[hdwm]?\\s*$",
  "description": "Sessions written within this window are ACTIVE and show a live state (running / needs you). Examples: 2h, 8h, 1d. Everything older is history."
},
"sessionFinder.toolQuietSeconds": {
  "type": "number",
  "default": 60,
  "minimum": 5,
  "description": "A session that has been waiting on a tool call for longer than this is shown as \"waiting on a tool or a permission prompt\". Raise it if your tests or builds run long."
},
"sessionFinder.stalledMinutes": {
  "type": "number",
  "default": 15,
  "minimum": 1,
  "description": "A session whose model has written nothing for this long is shown as stalled. Long answers are normal for several minutes, which is why the default is not lower."
}
```

Do **not** touch `activationEvents` or `extensionDependencies`.

- [ ] **Step 9: Typecheck (expected to fail on one line until Task 7)**

Run: `npm run typecheck`
Expected: exactly one error — `showSearchQuickPick` called with 2 arguments in `extension.ts`. Continue to Task 7 before committing.

---

### Task 7: State glyphs on Quick Pick rows

**Files:**
- Modify: `src/surfaces/quickpick.ts` (`toRow`, `showSearchQuickPick` signature, two call sites of `toRow`)
- Modify: `src/extension.ts` (the `sessionFinder.search` registration passes `host.liveness`)

**Interfaces:**
- Consumes: `stateIcon`, `projectLabel` (rows.ts); `Liveness` (state.ts).
- Produces: `showSearchQuickPick(ctx: vscode.ExtensionContext, liveness?: ReadonlyMap<string, Liveness>): Promise<void>` — second parameter new, optional (the e2e/manual path without a host still works).

- [ ] **Step 1: Change the imports and `toRow` in `src/surfaces/quickpick.ts`**

Add:

```ts
import { projectLabel, stateIcon } from '../core/rows.js';
import type { Liveness } from '../core/state.js';
```

Replace `toRow`'s signature and the first two lines of its body (`const m = …; const bits = …`) and its `label`:

```ts
function toRow(hit: SessionHit, liveness: ReadonlyMap<string, Liveness>): Row {
  const m = hit.session;
  const bits = [projectLabel(m.projectDir), m.branches.at(-1) ?? '', ago(m.lastTs)];
  if (m.prLinks.length) bits.push(`PR #${m.prLinks.at(-1)}`);
  if (!m.cwdExists) bits.push('⚠ folder missing');
  // Stage 1 (spec §9.3): the glyph is the session's live state; history keeps the sparkle.
  const live = liveness.get(m.sessionId);
  const glyph = live ? stateIcon({ state: live.state.kind, ...(live.state.kind === 'attention' ? { reason: live.state.reason } : {}) }) : 'sparkle';
  return {
    label: `$(${glyph}) ${m.title ?? hit.best?.text.slice(0, 60) ?? m.sessionId}`,
```

Everything else in `toRow` stays (including `alwaysShow: true` — F7).

- [ ] **Step 2: Thread `liveness` through `showSearchQuickPick`**

```ts
export async function showSearchQuickPick(
  ctx: vscode.ExtensionContext,
  liveness: ReadonlyMap<string, Liveness> = new Map(),
): Promise<void> {
```

and change both `.map(toRow)` calls to `.map(h => toRow(h, liveness))`.

- [ ] **Step 3: Pass the host's liveness in `src/extension.ts`**

```ts
  ctx.subscriptions.push(
    vscode.commands.registerCommand('sessionFinder.search', () => showSearchQuickPick(ctx, host.liveness)),
  );
```

`host` must therefore be created **before** this registration — move the `LiveHost` block from Task 6 Step 7 above it.

- [ ] **Step 4: Typecheck, lint, tests, build**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: all clean; `dist/extension.js` rebuilt.

- [ ] **Step 5: Manual verification in the Extension Development Host**

1. `code --extensionDevelopmentPath=$PWD` (or F5 from the `.code-workspace`).
2. With at least one Claude Code session open and working: the status bar shows `$(loading~spin) 1` within ~2 s of the window being focused. Hover: the tooltip lists it with its branch.
3. Let the session finish its turn: the segment flips to `$(bell-dot) 1` within one tick.
4. Trigger a permission prompt in a session and wait 60 s: the glyph stays `bell-dot`; in `Ctrl+Alt+S` the row for that session shows `$(bell-dot)` (search for a word from it).
5. Start a long reply (ask for a big refactor) and wait 2 min: the session stays `loading~spin` — this is L5; if it flips to `warning` the thresholds are wired backwards.
6. Unfocus the window for 30 s, refocus: the status bar updates within ~2 s.
7. Open a session from `Ctrl+Alt+S`, then run "Claude Code: Open" from the palette: it opens where the user last chose, not forced to a panel (L10 fix).
8. Settings → `sessionFinder.activeWindow` = `1h`: older sessions leave the status bar count on the next sweep (≤ 10 s).

Record the outcome of 5 and 7 in the PR description — they are the two behaviours the unit tests cannot observe.

- [ ] **Step 6: Commit Tasks 6 and 7 together**

```bash
git add src/live-host.ts src/surfaces/statusbar.ts src/surfaces/statusbar-escape.ts test/statusbar-escape.test.ts \
        src/surfaces/quickpick.ts src/extension.ts package.json
git commit -m "feat: live session state in the status bar and on search results

LiveHost turns the sessionFinder.* settings into a LivenessTracker, pauses it
while the window is unfocused, and refreshes the index only when a session
joins or leaves the ACTIVE set. The status bar shows running / needs-you counts
with a per-session tooltip; Quick Pick rows show the same glyphs.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Release 0.2.0

**Files:**
- Modify: `package.json` (`version`), `CHANGELOG.md`, `README.md`

- [ ] **Step 1: Bump the version**

Run: `npm version 0.2.0 --no-git-tag-version`
Expected: `package.json` and `package-lock.json` say `0.2.0`.

- [ ] **Step 2: CHANGELOG entry (in the existing voice — what broke or was missing, how it was found)**

Insert at the top of `CHANGELOG.md`, under `# Changelog`:

```markdown
## 0.2.0

**You can now see which sessions are running.** The status bar shows how many
Claude Code sessions are working and how many are waiting on you; hovering
lists them. Search results carry the same glyph. State is read from the
transcripts on disk — no hooks, no settings changes — by looking at the last
*conversational* record of each recently written session: the model's
`stop_reason` says whether it finished its turn or is waiting on a tool, and a
`user` record means it is still generating. That last rule matters: a long
answer writes nothing for minutes, and an earlier draft of this feature flagged
the very session that was writing it as "blocked". Thresholds are settings
(`sessionFinder.activeWindow`, `toolQuietSeconds`, `stalledMinutes`).

**Opening a session no longer resets your Claude Code "preferred location".**
`claude-vscode.editor.open` called without its sixth argument is treated by
Claude Code as a user-initiated open and rewrites the preferred location to
"panel". Every open from this extension had been doing that since 0.1.0. Calls
now pass `{ programmatic: true }`.

Also: `since:2h` works in searches (the window parser gained an hour unit).
```

- [ ] **Step 3: README section**

After the "Use it" table in `README.md`, add:

```markdown
## See what's running

The status bar shows `⟳ 2  🔔 3`: two sessions working, three waiting on you.
Hover for the list; click to open the session search. Rows in the search show
the same glyph:

| Glyph | Meaning |
|---|---|
| `⟳` spinning | the model is working (including long answers, which write nothing for a while) |
| `🔔` | waiting on a tool call for a while — usually a **permission prompt**, sometimes just a slow tool |
| `💬` | Claude finished its turn; it's your move |
| `⚠` | nothing written for 15+ minutes mid-turn — probably abandoned |

Only sessions written in the last `sessionFinder.activeWindow` (default 4 h)
carry a state. `sessionFinder.toolQuietSeconds` (60) and
`sessionFinder.stalledMinutes` (15) tune the two thresholds. Everything is read
from `~/.claude/projects`; nothing is installed into Claude Code's settings.
```

(Use the codicon names in prose if the marketplace strips emoji: `loading`, `bell-dot`, `comment-discussion`, `warning`.)

- [ ] **Step 4: Package and inspect**

Run: `npm run build && npx @vscode/vsce ls`
Expected: the listing contains `dist/extension.js`, `resources/icon.png`, `README.md`, `CHANGELOG.md`, `LICENSE`, `package.json` and **nothing** from `src/`, `test/`, `docs/`.

Run: `npm run package`
Expected: `claude-code-session-finder-0.2.0.vsix` written.

- [ ] **Step 5: Commit and tag**

```bash
npm run typecheck && npm run lint && npm test
git add package.json package-lock.json CHANGELOG.md README.md
git commit -m "chore: release 0.2.0 — live session state

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git tag v0.2.0
```

Publishing (`npm run publish:vsce`, `npm run publish:ovsx`) is the author's step, as in v0.1.

---

## Self-review (run once after writing; results applied inline)

**Spec coverage (Stage 1 scope):** L3/L4/L5 → Task 2; L6/L7/L8/L9 → Tasks 2–3; §8 cadences and pause → Tasks 3, 6; §9.2 → Task 6; §9.3 → Task 7; L10 → Task 5; D5 settings → Task 6; §12 (never throw from a timer, vanished files) → Task 3; §14 versioning/CHANGELOG/README → Task 8. Not in Stage 1 by design (D8): L11 (webview), L12 (`custom-title`), baton `where` *reading* (the write is already in place from Task 5), right-panel command.

**Placeholder scan:** none — every step carries its code or its exact command and expected output.

**Type consistency:** `TailVerdict` / `LiveState` / `Thresholds` / `Liveness` are defined once in `state.ts` and imported by `live.ts`, `rows.ts`, `quickpick.ts`, `live-host.ts` under those names. `Snapshot`/`LiveRow`/`HistoryRow` come from `rows.ts`. `openCommands`/`OpenWhere` from `open-args.ts`; `runOpen` from `open.ts`. `showSearchQuickPick(ctx, liveness?)` matches both call sites in `extension.ts`. `SHOW_SESSIONS` string equals the `package.json` command id `sessionFinder.showSessions`.
