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
 *  - thinking blocks are redacted on disk (`thinking: ''`, signature only) — shown as a marker.
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
  isSidechain?: boolean; isMeta?: boolean; agentId?: string; durationMs?: number;
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

// ---------------------------------------------------------------- turns

export interface ToolCall {
  id: string; name: string; summary: string; input: Record<string, unknown>; ts: number;
  result?: { text: string; isError: boolean; ts: number; images: number; truncated: number };
  /** set when the call spawned an agent / workflow — the reader links it to the graph node */
  agentId?: string; runId?: string;
}
export type Item =
  | { kind: 'text'; ts: number; text: string }
  | { kind: 'thinking'; ts: number }
  | { kind: 'tool'; call: ToolCall }
  | { kind: 'image'; ts: number; mediaType: string; dataUrl: string };
export type PromptKind = 'user' | 'notification' | 'meta';
export interface Turn {
  index: number; startTs: number; endTs: number;
  promptKind: PromptKind; prompt: string; promptImages: number;
  items: Item[];
  model?: string; outputTokens: number; thinkingTokens: number; durationMs?: number;
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

  for (const r of recs) {
    const t = ts(r);
    if (t) { firstTs = firstTs ? Math.min(firstTs, t) : t; lastTs = Math.max(lastTs, t); }
    const m = r.message; const c = m?.content;

    if (r.type === 'user') {
      if (typeof c === 'string') {
        if (isNotification(c)) open(t, 'notification', parseNotification(c).summary, 0);
        else open(t, r.isMeta ? 'meta' : 'user', c, 0);
        continue;
      }
      if (!Array.isArray(c)) { hidden++; continue; }
      const results = c.filter((b): b is ToolResultBlock => b.type === 'tool_result');
      if (results.length) {
        const turn = ensure(t);
        for (const b of results) {
          const call = pending.get(b.tool_use_id);
          if (!call) continue;
          const { text, images, truncated } = resultText(b);
          call.result = { text, isError: b.is_error === true, ts: t, images, truncated };
          attachSpawn(call, r.toolUseResult);
          pending.delete(b.tool_use_id);
        }
        turn.endTs = Math.max(turn.endTs, t);
        continue;
      }
      const text = c.filter((b): b is TextBlock => b.type === 'text').map(b => b.text).join('\n');
      const images = c.filter((b): b is ImageBlock => b.type === 'image');
      const turn = isNotification(text)
        ? open(t, 'notification', parseNotification(text).summary, images.length)
        : open(t, r.isMeta ? 'meta' : 'user', text, images.length);
      for (const im of images) {
        const dataUrl = imageDataUrl(im);
        if (dataUrl) turn.items.push({ kind: 'image', ts: t, mediaType: im.source?.media_type ?? 'image/png', dataUrl });
      }
      continue;
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
          else if (b.type === 'thinking') turn.items.push({ kind: 'thinking', ts: t });
          else if (b.type === 'tool_use') {
            const tu = b as ToolUseBlock;
            const call: ToolCall = { id: tu.id, name: tu.name, summary: toolSummary(tu.name, tu.input), input: tu.input ?? {}, ts: t };
            pending.set(tu.id, call);
            turn.items.push({ kind: 'tool', call });
          }
        }
      }
      turn.endTs = Math.max(turn.endTs, t);
      continue;
    }

    if (r.type === 'system') {
      if (r.subtype === 'turn_duration' && cur) { cur.durationMs = r.durationMs; cur.endTs = Math.max(cur.endTs, t); }
      hidden++;
      continue;
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
    if (text.trim() && !isNotification(text)) return text.trim().split('\n')[0]!.slice(0, 120);
  }
  return undefined;
}
