import type { SourceFile } from './discover.js';

/** What the last conversational record says, independent of time (spec §6). */
export type TailVerdict =
  | 'turn-ended'      // assistant end_turn, or system turn_duration | away_summary | local_command
  | 'awaiting-tool'   // assistant tool_use — a tool is running OR a permission prompt is showing
  | 'awaiting-answer' // assistant tool_use of AskUserQuestion — Claude asked you something
  | 'awaiting-model'  // user (prompt or tool_result), or an assistant record that is still streaming
  | 'interrupted'     // user "[Request interrupted by user]" — you stopped it; nothing runs
  | 'unknown';        // nothing conversational in the window

export type AttentionReason = 'tool-or-permission' | 'question' | 'your-turn' | 'interrupted' | 'stalled';
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

const CONVERSATIONAL = new Set(['user', 'assistant', 'system']);
/** system subtypes that end a turn. Others (e.g. compact_boundary) are not boundaries and are skipped. */
const TURN_BOUNDARY = new Set(['turn_duration', 'away_summary', 'local_command']);

interface Rec { type?: string; subtype?: string; isSidechain?: boolean; message?: { stop_reason?: string | null; content?: unknown } }

/** Esc in Claude Code writes this as a user message; the loop is over until you type again. */
const INTERRUPTED = /^\s*\[Request interrupted by user(?: for tool use)?\]\s*$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b): b is { type: 'text'; text: string } => isObj(b) && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
}
const asksQuestion = (content: unknown): boolean =>
  Array.isArray(content) && content.some(b => isObj(b) && b.type === 'tool_use' && b.name === 'AskUserQuestion');

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
      if (stop === 'tool_use') return asksQuestion(d.message?.content) ? 'awaiting-answer' : 'awaiting-tool';
      return 'awaiting-model';               // null (streaming), max_tokens, stop_sequence: the loop continues
    }
    if (d.type === 'system') {
      if (d.subtype && TURN_BOUNDARY.has(d.subtype)) return 'turn-ended';
      continue;
    }
    if (INTERRUPTED.test(textOf(d.message?.content))) return 'interrupted';
    return 'awaiting-model';                 // user: a prompt or a tool_result the model has not answered
  }
  return 'unknown';
}

/**
 * Spec §7 table. `turn-ended` ignores quiet time on purpose. `unknown` — a tail with nothing
 * conversational, which a written-moments-ago file can still have — is read like `awaiting-model`:
 * recency decided the session is ACTIVE, and the verdict only refines how it shows.
 */
export function resolveState(
  verdict: TailVerdict, quietMs: number, t: Thresholds = DEFAULT_THRESHOLDS,
): LiveState {
  switch (verdict) {
    case 'turn-ended':     return { kind: 'attention', reason: 'your-turn' };
    case 'awaiting-answer': return { kind: 'attention', reason: 'question' };
    case 'interrupted':    return { kind: 'attention', reason: 'interrupted' };
    case 'awaiting-tool':  return quietMs < t.toolQuietMs ? { kind: 'running' } : { kind: 'attention', reason: 'tool-or-permission' };
    case 'awaiting-model':
    case 'unknown':        return quietMs < t.stalledMs   ? { kind: 'running' } : { kind: 'attention', reason: 'stalled' };
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
