import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyTail, resolveState, pickMainFile, effectiveMtime, DEFAULT_THRESHOLDS } from '../src/core/state.js';
import { readTail, readVerdict, TAIL_WINDOW } from '../src/core/tail-io.js';
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
  it('unknown reads like awaiting-model: recency put the session in ACTIVE, the verdict only refines it', () => {
    expect(resolveState('unknown', 0, t)).toEqual({ kind: 'running' });
    expect(resolveState('unknown', t.stalledMs, t)).toEqual({ kind: 'attention', reason: 'stalled' });
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
  it('readVerdict keeps widening — to the whole file — when one huge record hides the last conversational one', async () => {
    // A 700 KB tool_result (one screenshot read as an image) followed by sidecars: the 64 KB and 512 KB
    // windows both start inside that record, drop it as a partial line, and see only sidecars.
    const f = join(dir, 'image-heavy.jsonl');
    const huge = line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(700_000) }] } });
    const sidecar = line({ type: 'attachment', blob: 'y'.repeat(200) });
    writeFileSync(f, assistant('tool_use') + '\n' + huge + '\n' + sidecar + '\n' + sidecar + '\n');
    const size = statSync(f).size;
    const reads: number[] = [];
    const spy = (p: string, s: number, w?: number) => { reads.push(w ?? TAIL_WINDOW); return readTail(p, s, w); };
    expect(await readVerdict(f, size, spy)).toBe('awaiting-model');
    expect(reads).toEqual([65_536, 524_288, 2_097_152]);           // 2 MB covers the 700 KB file: stop there
  });
  it('an empty file is unknown without opening a read of zero bytes', async () => {
    const f = join(dir, 'empty.jsonl');
    writeFileSync(f, '');
    expect(await readVerdict(f, 0)).toBe('unknown');
  });
});
