/**
 * Transcript model for the Session View: JSONL records → readable turns.
 * Pure — no vscode, no fs. The host reads files and hands the text here; the webview renders Turns.
 *
 * Record shapes (measured on the author's corpus, 2026-09-17):
 *  - `user`: string content (a prompt, or a `<task-notification>` from a background agent),
 *    text/image blocks (a prompt), or tool_result blocks (answers to earlier tool_use blocks).
 *  - `assistant`: one record per streamed block; `message.usage` repeats per record of the same
 *    `message.id`, so tokens are counted per message, never per record.
 *  - `system`: turn_duration / away_summary / local_command / … — boundaries, never shown.
 *  - everything else (attachment, last-prompt, cost-state, …) is housekeeping and counted as hidden.
 *  - a thinking block keeps its text on disk only sometimes: Claude Code ≤ 2.1.274 kept none; later versions keep
 *    it for about a quarter of Opus and Fable thoughts and for no Sonnet or Haiku ones (author's corpus,
 *    2026-10-08). The rest are `thinking: ''` with a signature only — nothing can show those (D20).
 */

export interface TextBlock { type: 'text'; text: string }
export interface ThinkingBlock { type: 'thinking'; thinking?: string }
export interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input?: Record<string, unknown> }
export interface ImageSource { type?: string; media_type?: string; data?: string }
export interface ImageBlock { type: 'image'; source?: ImageSource }
export interface ToolResultBlock {
  type: 'tool_result'; tool_use_id: string; is_error?: boolean;
  content?: string | Array<{ type?: string; text?: string; source?: ImageSource }>;
}
export type Block = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | ImageBlock | { type: string };

export interface Usage { output_tokens?: number; output_tokens_details?: { thinking_tokens?: number } }
export interface Rec {
  type?: string; subtype?: string; timestamp?: string; uuid?: string;
  isSidechain?: boolean; isMeta?: boolean; agentId?: string; durationMs?: number; cwd?: string;
  message?: { id?: string; role?: string; model?: string; stop_reason?: string | null; content?: string | Block[]; usage?: Usage };
  toolUseResult?: unknown;
  attachment?: { type?: string };
}

/** Every parseable line. A torn last line (a write in progress) is skipped, never an error. */
export function parseRecords(text: string): Rec[] {
  const out: Rec[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as Rec); } catch { /* torn line */ }
  }
  return out;
}

export function ts(r: Rec): number {
  const t = r.timestamp ? Date.parse(r.timestamp) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------- tool calls

/** What a compact tool row says after the tool name. */
export function toolSummary(name: string, input: Record<string, unknown> = {}): string {
  const s = (k: string): string => { const v = input[k]; return typeof v === 'string' ? v : ''; };
  const base = (v: unknown): string => typeof v === 'string' ? (v.split(/[\\/]/).pop() ?? v) : '';
  const firstLine = (v: string): string => (v.split('\n')[0] ?? '').slice(0, 120);
  switch (name) {
    case 'Bash': return firstLine(s('description') || s('command'));
    case 'Read': case 'Edit': case 'Write': case 'MultiEdit': return base(input.file_path);
    case 'NotebookEdit': return base(input.notebook_path);
    case 'Agent': case 'Task': return firstLine(s('description') || s('subagent_type') || 'agent');
    case 'Workflow': return firstLine(s('description') || 'workflow');
    case 'Skill': return s('skill');
    case 'WebFetch': return s('url');
    case 'WebSearch': return s('query');
    case 'Grep': case 'Glob': return s('pattern');
    case 'SendMessage': return s('to') || s('recipient');
    case 'AskUserQuestion': {
      const q = input.questions;
      const first = Array.isArray(q) ? q[0] as unknown : undefined;
      return isRecord(first) && typeof first.question === 'string' ? firstLine(first.question) : '';
    }
    default:
      for (const v of Object.values(input)) if (typeof v === 'string' && v.trim()) return firstLine(v);
      return '';
  }
}

/** Tool output is capped for the view; the raw transcript is always one click away. */
export const RESULT_CAP = 20_000;

export interface ResultText { text: string; images: number; truncated: number }
export function resultText(b: ToolResultBlock): ResultText {
  let text = ''; let images = 0;
  if (typeof b.content === 'string') text = b.content;
  else if (Array.isArray(b.content)) {
    const parts: string[] = [];
    for (const p of b.content) {
      if (p?.type === 'text' && typeof p.text === 'string') parts.push(p.text);
      else if (p?.type === 'image') images++;
    }
    text = parts.join('\n');
  }
  const truncated = Math.max(0, text.length - RESULT_CAP);
  return { text: truncated ? text.slice(0, RESULT_CAP) : text, images, truncated };
}

// ---------------------------------------------------------------- background-agent notifications

export interface Notification { taskId?: string; toolUseId?: string; status?: string; summary: string; result?: string }

/** `<task-notification>` payloads arrive as plain user text; the tags are stable and flat. */
export function parseNotification(text: string): Notification {
  const tag = (name: string): string | undefined => {
    const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
    return m ? m[1]!.trim() : undefined;
  };
  const summary = tag('summary') ?? tag('status') ?? 'background task update';
  const out: Notification = { summary };
  const taskId = tag('task-id'); if (taskId) out.taskId = taskId;
  const toolUseId = tag('tool-use-id'); if (toolUseId) out.toolUseId = toolUseId;
  const status = tag('status'); if (status) out.status = status;
  const result = tag('result'); if (result) out.result = result;
  return out;
}

export const isNotification = (text: string): boolean => text.includes('<task-notification>');

/**
 * A slash command the CLI echoed into the transcript — `<command-name>/model</command-name>…`, its
 * `<local-command-stdout>`, or the `<local-command-caveat>` that precedes them. Not a prompt: never a
 * title, and shown in the reader as a command rather than as something "you" said.
 */
export const isLocalCommand = (text: string): boolean => /^\s*<(?:command-name|local-command-stdout|local-command-caveat)>/.test(text);
const tagOf = (text: string, name: string): string => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? '';
/** `<command-name>/model</command-name>…<command-args>opus</command-args>` → "/model opus" */
export function commandLine(text: string): string {
  return [tagOf(text, 'command-name'), tagOf(text, 'command-args')].filter(Boolean).join(' ') || text.trim().slice(0, 120);
}

// ---------------------------------------------------------------- turns

export interface ToolCall {
  id: string; name: string; summary: string; input: Record<string, unknown>; ts: number;
  result?: { text: string; isError: boolean; ts: number; images: number; truncated: number };
  /** set when the call spawned an agent / workflow — the reader links it to the graph node */
  agentId?: string; runId?: string;
}
export type Item =
  | { kind: 'text'; ts: number; text: string }
  /** text: when the transcript kept it (D20); otherwise a thought saved as a signature only */
  | { kind: 'thinking'; ts: number; text?: string }
  | { kind: 'tool'; call: ToolCall }
  | { kind: 'image'; ts: number; mediaType: string; dataUrl: string }
  /** an isMeta user record — a skill body, a system reminder — injected mid-turn; the turn goes on */
  | { kind: 'context'; ts: number; text: string };
export type PromptKind = 'user' | 'notification' | 'meta' | 'command';
export interface Turn {
  index: number; startTs: number; endTs: number;
  promptKind: PromptKind; prompt: string; promptImages: number;
  items: Item[];
  model?: string; outputTokens: number; thinkingTokens: number; durationMs?: number;
  /** the folder the session was in during this turn — where a relative file name in it resolves first (D20) */
  cwd?: string;
}
export interface Transcript { turns: Turn[]; records: number; hidden: number; firstTs: number; lastTs: number; model?: string }

/** Images above this many base64 chars are not inlined into the view (the raw transcript has them). */
const IMAGE_CAP = 2_000_000;
function imageDataUrl(b: ImageBlock): string | undefined {
  const s = b.source;
  if (!s || s.type !== 'base64' || typeof s.data !== 'string' || !s.data || s.data.length > IMAGE_CAP) return undefined;
  return `data:${s.media_type ?? 'image/png'};base64,${s.data}`;
}

function attachSpawn(call: ToolCall, tur: unknown): void {
  if (!isRecord(tur)) return;
  if (typeof tur.agentId === 'string') call.agentId = tur.agentId;
  if (typeof tur.runId === 'string') call.runId = tur.runId;
}

export function buildTranscript(recs: Rec[]): Transcript {
  const turns: Turn[] = [];
  const pending = new Map<string, ToolCall>();
  const usageByMessage = new Map<string, { turn: Turn; out: number; think: number }>();
  let cur: Turn | undefined;
  let hidden = 0, firstTs = 0, lastTs = 0;
  let model: string | undefined;

  const open = (t: number, promptKind: PromptKind, prompt: string, promptImages: number): Turn => {
    cur = { index: turns.length, startTs: t, endTs: t, promptKind, prompt, promptImages, items: [], outputTokens: 0, thinkingTokens: 0 };
    turns.push(cur);
    return cur;
  };
  const ensure = (t: number): Turn => cur ?? open(t, 'meta', '', 0);
  // a slash command echoed by the CLI: the caveat is noise, the command opens a turn, its stdout is that turn's output
  const localCommand = (text: string, t: number): void => {
    if (text.trimStart().startsWith('<local-command-caveat>')) { hidden++; return; }
    if (text.trimStart().startsWith('<command-name>')) { open(t, 'command', commandLine(text), 0); return; }
    const turn = ensure(t); const out = tagOf(text, 'local-command-stdout');
    if (out) turn.items.push({ kind: 'text', ts: t, text: out });
    turn.endTs = Math.max(turn.endTs, t);
  };

  for (const r of recs) {
    const t = ts(r);
    if (t) { firstTs = firstTs ? Math.min(firstTs, t) : t; lastTs = Math.max(lastTs, t); }
    const m = r.message; const c = m?.content;
    const before = cur;
    try { step(r, t, m, c); } finally { if (r.cwd && cur && (cur !== before || !cur.cwd)) cur.cwd = r.cwd; }
  }
  function step(r: Rec, t: number, m: Rec['message'], c: string | Block[] | undefined): void {
    if (r.type === 'user') {
      if (typeof c === 'string') {
        if (isLocalCommand(c)) localCommand(c, t);
        else if (isNotification(c)) open(t, 'notification', parseNotification(c).summary, 0);
        else if (r.isMeta) { const turn = ensure(t); turn.items.push({ kind: 'context', ts: t, text: c }); turn.endTs = Math.max(turn.endTs, t); }
        else open(t, 'user', c, 0);
        return;
      }
      if (!Array.isArray(c)) { hidden++; return; }
      const results = c.filter((b): b is ToolResultBlock => b.type === 'tool_result');
      if (results.length) {
        const turn = ensure(t);
        for (const b of results) {
          const call = pending.get(b.tool_use_id);
          if (!call) return;
          const { text, images, truncated } = resultText(b);
          call.result = { text, isError: b.is_error === true, ts: t, images, truncated };
          attachSpawn(call, r.toolUseResult);
          pending.delete(b.tool_use_id);
        }
        turn.endTs = Math.max(turn.endTs, t);
        return;
      }
      const text = c.filter((b): b is TextBlock => b.type === 'text').map(b => b.text).join('\n');
      const images = c.filter((b): b is ImageBlock => b.type === 'image');
      if (isLocalCommand(text)) { localCommand(text, t); return; }
      if (r.isMeta && !isNotification(text)) {                  // injected context, not a new prompt
        const turn = ensure(t);
        if (text) turn.items.push({ kind: 'context', ts: t, text });
        turn.endTs = Math.max(turn.endTs, t);
        return;
      }
      const turn = isNotification(text)
        ? open(t, 'notification', parseNotification(text).summary, images.length)
        : open(t, 'user', text, images.length);
      for (const im of images) {
        const dataUrl = imageDataUrl(im);
        if (dataUrl) turn.items.push({ kind: 'image', ts: t, mediaType: im.source?.media_type ?? 'image/png', dataUrl });
      }
      return;
    }

    if (r.type === 'assistant') {
      const turn = ensure(t);
      if (m?.model) { turn.model = m.model; model = m.model; }
      if (m?.id && m.usage) {                                   // per message, not per streamed record
        usageByMessage.set(m.id, { turn, out: m.usage.output_tokens ?? 0, think: m.usage.output_tokens_details?.thinking_tokens ?? 0 });
      }
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'text') { const tb = b as TextBlock; if (tb.text) turn.items.push({ kind: 'text', ts: t, text: tb.text }); }
          else if (b.type === 'thinking') { const text = ((b as ThinkingBlock).thinking ?? '').trim(); turn.items.push(text ? { kind: 'thinking', ts: t, text } : { kind: 'thinking', ts: t }); }
          else if (b.type === 'tool_use') {
            const tu = b as ToolUseBlock;
            const call: ToolCall = { id: tu.id, name: tu.name, summary: toolSummary(tu.name, tu.input), input: tu.input ?? {}, ts: t };
            pending.set(tu.id, call);
            turn.items.push({ kind: 'tool', call });
          }
        }
      }
      turn.endTs = Math.max(turn.endTs, t);
      return;
    }

    if (r.type === 'system') {
      if (r.subtype === 'turn_duration' && cur) { cur.durationMs = r.durationMs; cur.endTs = Math.max(cur.endTs, t); }
      hidden++;
      return;
    }
    hidden++;
  }

  for (const { turn, out, think } of usageByMessage.values()) { turn.outputTokens += out; turn.thinkingTokens += think; }
  const out: Transcript = { turns, records: recs.length, hidden, firstTs, lastTs };
  if (model) out.model = model;
  return out;
}

/** The first human prompt in a file — the label for an agent whose spawner is unknown. */
export function firstPrompt(recs: Rec[]): string | undefined {
  for (const r of recs) {
    if (r.type !== 'user' || r.isMeta) continue;
    const c = r.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b): b is TextBlock => b.type === 'text').map(b => b.text).join('\n') : '';
    if (!text.trim() || isNotification(text) || isLocalCommand(text)) continue;
    // skip blank lines and markdown headings ("# Question") — the first substantive line labels the agent
    const line = text.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
    if (line) return line.slice(0, 120);
  }
  return undefined;
}

// ---------------------------------------------------------------- what an agent is doing, and has done (D20)

export interface NowStep { tool: string; summary: string; since: number }

/**
 * The call a live transcript is in the middle of: the last tool_use with no result yet, read from the end and
 * stopping at a finished turn. A transcript records a tool's output only when it ends, so this names the call
 * and how long it has run — never its output so far.
 */
export function currentStep(recs: Rec[]): NowStep | undefined {
  const answered = new Set<string>();
  for (let i = recs.length - 1, seen = 0; i >= 0 && seen < 400; i--, seen++) {
    const r = recs[i]!; const c = r.message?.content;
    if (r.type === 'user' && Array.isArray(c)) { for (const b of c) if (b.type === 'tool_result') answered.add((b as ToolResultBlock).tool_use_id); continue; }
    if (r.type !== 'assistant') continue;
    if (r.message?.stop_reason === 'end_turn') return undefined;
    if (!Array.isArray(c)) continue;
    for (let j = c.length - 1; j >= 0; j--) {
      const b = c[j]!;
      if (b.type === 'tool_use') { const tu = b as ToolUseBlock; if (!answered.has(tu.id)) return { tool: tu.name, summary: toolSummary(tu.name, tu.input), since: ts(r) }; return undefined; }
      if (b.type === 'thinking') return { tool: 'Think', summary: 'thinking', since: ts(r) };
      if (b.type === 'text') return { tool: 'Text', summary: 'writing', since: ts(r) };
    }
  }
  return undefined;
}

export interface Step { ts: number; tool: string; summary: string; ms?: number; status: 'ok' | 'error' | 'running' }
export interface Overview {
  /** what the agent was asked: its first prompt */
  task?: string;
  /** the latest steps, oldest first; `steps` holds at most `max`, `totalSteps` counts them all */
  steps: Step[]; totalSteps: number;
  /** the last thing it wrote, and — once it has stopped — its answer */
  lastText?: string;
  /** a call still in flight */
  running?: Step;
}

/** The Overview tab of an agent's pane (D20): its task, its steps (tool calls), and the last thing it said. */
export function overview(t: Transcript, max = 14): Overview {
  const firstUser = t.turns.find(x => x.promptKind === 'user' && x.prompt.trim());
  const steps: Step[] = []; let lastText: string | undefined; let running: Step | undefined;
  for (const turn of t.turns) for (const it of turn.items) {
    if (it.kind === 'text' && it.text.trim()) lastText = it.text;
    if (it.kind !== 'tool') continue;
    const c = it.call;
    const st: Step = { ts: c.ts, tool: c.name, summary: c.summary, status: c.result ? (c.result.isError ? 'error' : 'ok') : 'running' };
    if (c.result) st.ms = Math.max(0, c.result.ts - c.ts);
    steps.push(st);
  }
  const last = steps[steps.length - 1];
  if (last?.status === 'running') running = last;
  const out: Overview = { steps: steps.slice(-max), totalSteps: steps.length };
  if (firstUser) out.task = firstUser.prompt;
  if (lastText) out.lastText = lastText;
  if (running) out.running = running;
  return out;
}
