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
