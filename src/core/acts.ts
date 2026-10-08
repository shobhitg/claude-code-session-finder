/**
 * When you last did something to a session — the order of both sidebar lists (D14). Only you move a
 * row: a prompt (typed, or queued while Claude works), a slash command, Esc, or an answer to a question
 * or a plan. Claude's replies and tool calls, background-task notifications, other sessions' messages,
 * compaction and a shutdown are not you. Approving a permission prompt leaves no record of its own (its
 * tool_result is an auto-approved call's), so it does not count; a rejection comes with an
 * "[Request interrupted by user for tool use]" line, which does.
 */
export interface ActRec {
  type?: string; timestamp?: string;
  isSidechain?: boolean; isMeta?: boolean; isCompactSummary?: boolean; interruptedByShutdown?: boolean; toolDenialUnanswered?: boolean;
  /** newer Claude Code says who wrote a prompt: 'human', 'task-notification', 'peer'… */
  origin?: { kind?: string };
  /** …and on records without `origin`, whether the turn was a person's ('human') or a program's ('sdk') */
  turnOrigin?: string;
  message?: { content?: unknown };
  attachment?: { type?: string; commandMode?: string; origin?: { kind?: string } };
}

/** Questions only you can answer: an answer to one is you acting (D13 rings on the same two). */
const QUESTIONS = new Set(['AskUserQuestion', 'ExitPlanMode']);
/** What the CLI writes back around a slash command — the command itself (`<command-name>`) is you; these are not — and a background task's notification. */
const NOT_YOU = /^\s*<(?:local-command-stdout|local-command-caveat|task-notification)>/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const blocks = (c: unknown): Record<string, unknown>[] => Array.isArray(c) ? c.filter(isObj) : [];

/** Feed a transcript's records in file order; `last` is the timestamp of the newest one that was you. */
export function actClock(): { see(r: ActRec): void; readonly last: number | undefined } {
  const asks = new Set<string>();
  let last: number | undefined;
  return {
    see(r) {
      if (!isAct(r, asks) || typeof r.timestamp !== 'string') return;
      const t = Date.parse(r.timestamp);
      if (Number.isFinite(t) && (last === undefined || t > last)) last = t;
    },
    get last() { return last; },
  };
}

export function lastAct(recs: Iterable<ActRec>): number | undefined {
  const clock = actClock();
  for (const r of recs) clock.see(r);
  return clock.last;
}

function isAct(r: ActRec, asks: Set<string>): boolean {
  if (r.isSidechain || r.isMeta || r.isCompactSummary || r.interruptedByShutdown) return false;
  const c = r.message?.content;
  if (r.type === 'assistant') {
    for (const b of blocks(c)) if (b.type === 'tool_use' && QUESTIONS.has(b.name as string) && typeof b.id === 'string') asks.add(b.id);
    return false;
  }
  if (r.type === 'attachment') {                       // a prompt typed while Claude works arrives mid-turn as an attachment
    const a = r.attachment;
    return a?.type === 'queued_command' && (a.origin?.kind ?? (a.commandMode === 'prompt' ? 'human' : undefined)) === 'human';
  }
  if (r.type !== 'user') return false;
  const results = blocks(c).filter(b => b.type === 'tool_result');
  if (results.length) return !r.toolDenialUnanswered && results.some(b => asks.has(b.tool_use_id as string));
  const said = r.origin?.kind ?? r.turnOrigin;
  if (said !== undefined) return said === 'human';
  const text = typeof c === 'string' ? c : blocks(c).filter(b => b.type === 'text').map(b => String(b.text ?? '')).join('\n');
  if (!text.trim()) return blocks(c).some(b => b.type === 'image');
  return !NOT_YOU.test(text);
}
