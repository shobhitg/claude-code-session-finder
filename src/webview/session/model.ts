/**
 * Pure view-model for the Session View (D20): the threaded timeline, the agent list, the Markdown the reader
 * renders, file names in text, and the JSON views. Tested in node; main.ts turns these into elements.
 */
import type { GraphNode, NodeKind, NodeStatus, SessionGraph } from '../../core/agents.js';
import { IDLE_MS } from '../../core/agents.js';
import { fmtDuration } from '../model.js';

export function statusIcon(kind: NodeKind, status: NodeStatus, reducedMotion = false): string {
  if (status === 'running' || status === 'launched') return reducedMotion ? 'circle-large-filled' : 'loading~spin';
  if (kind === 'failed-spawn' || status === 'failed') return 'error';
  if (status === 'stopped') return 'circle-slash';
  if (status === 'completed') return kind === 'workflow' ? 'type-hierarchy' : 'check';
  return 'circle-large-outline';
}

export function iconClasses(name: string): string {
  const [base, mod] = name.split('~');
  return `codicon codicon-${base}${mod ? ` codicon-modifier-${mod}` : ''}`;
}

export function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

const pad = (n: number): string => String(n).padStart(2, '0');
export function fmtClock(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "14:09", or "Oct 7 14:09" when the timeline spans more than one day. */
export function fmtWhen(t: number, withDay: boolean): string {
  const d = new Date(t);
  return `${withDay ? `${MONTHS[d.getMonth()]} ${d.getDate()} ` : ''}${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A tree row's tooltip: what the node did, in numbers. */
export function nodeMeta(n: GraphNode, now: number): string {
  const bits: string[] = [];
  if (n.kind === 'failed-spawn') bits.push('spawn failed');
  else if (n.status === 'running' || n.status === 'launched') bits.push(`running · ${fmtDuration(now - (n.spawnTs ?? now))}`);
  else if (n.durationMs) bits.push(fmtDuration(n.durationMs));
  else if (n.spawnTs && n.endTs) bits.push(fmtDuration(n.endTs - n.spawnTs));
  if (n.totalTokens) bits.push(`${fmtTokens(n.totalTokens)} tokens`);
  if (n.toolUses) bits.push(`${n.toolUses} tools`);
  if (n.model && n.kind !== 'session') bits.push(n.model.replace(/^claude-/, ''));
  if (n.background) bits.push('background');
  return bits.join(' · ');
}

export const isLive = (s: NodeStatus): boolean => s === 'running' || s === 'launched';

/** A model as a chip (D20): its family, and a tier the chip's cyan deepens with — lighter for smaller models. */
export function modelChip(model: string | undefined): { label: string; tier: 1 | 2 | 3 } | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  if (m.includes('haiku')) return { label: 'haiku', tier: 1 };
  if (m.includes('sonnet')) return { label: 'sonnet', tier: 2 };
  if (m.includes('opus')) return { label: 'opus', tier: 3 };
  if (m.includes('fable')) return { label: 'fable', tier: 3 };
  return { label: m.replace(/^claude-/, '').split('-')[0] ?? m, tier: 2 };
}

export function toolIcon(name: string): string {
  switch (name) {
    case 'Bash': return 'terminal';
    case 'Read': return 'file';
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return 'edit';
    case 'Write': return 'new-file';
    case 'Agent': case 'Task': return 'type-hierarchy-sub';
    case 'Workflow': return 'type-hierarchy';
    case 'Grep': case 'Glob': case 'ToolSearch': return 'search';
    case 'WebFetch': case 'WebSearch': return 'globe';
    case 'Skill': return 'sparkle';
    case 'AskUserQuestion': return 'question';
    case 'SendMessage': return 'comment';
    case 'StructuredOutput': return 'json';
    case 'Think': return 'lightbulb';
    case 'Text': return 'comment';
    default: return 'tools';
  }
}

// ---------------------------------------------------------------- the agent list

export interface ListRow { id: string; depth: number }
export type ListEntry = { kind: 'row'; id: string; depth: number } | { kind: 'group'; id: string; rows: ListRow[]; counts: Partial<Record<NodeStatus, number>> };

/**
 * The agent list (D20): the session first, then each thing it started in order. A workflow is a group — its
 * header, a strip of its agents' outcomes, then its agents; an agent that started agents keeps them under it.
 */
export function listModel(g: SessionGraph): ListEntry[] {
  const out: ListEntry[] = [{ kind: 'row', id: g.root, depth: 0 }];
  const below = (id: string, depth: number, acc: ListRow[]): ListRow[] => {
    for (const c of g.nodes[id]?.children ?? []) { acc.push({ id: c, depth }); below(c, depth + 1, acc); }
    return acc;
  };
  for (const id of g.nodes[g.root]?.children ?? []) {
    const n = g.nodes[id]; if (!n) continue;
    if (n.kind === 'workflow') {
      const rows = below(id, 0, []);
      const counts: Partial<Record<NodeStatus, number>> = {};
      for (const r of rows) { const s = g.nodes[r.id]!.status; counts[s] = (counts[s] ?? 0) + 1; }
      out.push({ kind: 'group', id, rows, counts });
    } else {
      out.push({ kind: 'row', id, depth: 0 });
      for (const r of below(id, 1, [])) out.push({ kind: 'row', ...r });
    }
  }
  return out;
}

// ---------------------------------------------------------------- the threaded timeline

export interface ThreadLane { id: string; depth: number; y: number; status: NodeStatus; kind: NodeKind; parent?: string; start: number; end: number; open: boolean; x0: number; x1: number }
export interface ThreadSeg { a: number; b: number; x0: number; x1: number }
export interface ThreadGap { x: number; w: number; idleMs: number }
export interface ThreadTick { x: number; label: string; anchor: 'start' | 'end' }
export interface ThreadLayout { lanes: ThreadLane[]; segs: ThreadSeg[]; gaps: ThreadGap[]; ticks: ThreadTick[]; height: number; nowX?: number }
export interface ThreadOpts { width: number; labelW: number; lane: number; top: number; gapW: number; right?: number; idleMs?: number }

/** When a node ran: from its spawn to its end, or to now while it is live, or an instant. */
function spanOf(n: GraphNode, now: number): [number, number] | undefined {
  if (!n.spawnTs) return undefined;
  const end = n.endTs ?? (isLive(n.status) ? now : (n.launchedTs ?? n.spawnTs));
  return [n.spawnTs, Math.max(end, n.spawnTs)];
}

/**
 * The threaded timeline (D20): the clock, but with every stretch nobody was working — longer than `idleMs` —
 * folded into a fixed gap labelled with its length, so a two-day session's bursts of work are not slivers.
 * Each node is a lane; its thread leaves its parent's lane at the moment it was started.
 */
export function threadLayout(g: SessionGraph, now: number, o: ThreadOpts): ThreadLayout {
  const idle = o.idleMs ?? IDLE_MS, right = o.right ?? 12;
  const root = g.nodes[g.root];
  const busy: Array<[number, number]> = [];
  for (const s of root?.spans ?? []) busy.push([s[0], s[1]]);
  for (const id of g.order) { const n = g.nodes[id]; const s = n && n !== root ? spanOf(n, now) : undefined; if (s) busy.push(s); }
  if (root && isLive(root.status)) busy.push([now, now]);
  if (!busy.length && root?.spawnTs) busy.push([root.spawnTs, root.endTs ?? now]);
  busy.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [a, b] of busy) { const last = merged[merged.length - 1]; if (last && a - last[1] <= idle) last[1] = Math.max(last[1], b); else merged.push([a, b]); }
  const lanes: ThreadLane[] = [];
  if (!merged.length) return { lanes, segs: [], gaps: [], ticks: [], height: o.top };
  // each busy stretch gets width by its length, never less than a couple of minutes' worth
  const weight = ([a, b]: [number, number]): number => Math.max(b - a, 2 * 60_000);
  const total = merged.reduce((t, s) => t + weight(s), 0);
  const avail = Math.max(60, o.width - o.labelW - right - o.gapW * (merged.length - 1));
  const segs: ThreadSeg[] = []; const gaps: ThreadGap[] = [];
  let x = o.labelW;
  merged.forEach((s, i) => {
    const w = avail * weight(s) / total; segs.push({ a: s[0], b: s[1], x0: x, x1: x + w }); x += w;
    if (i < merged.length - 1) { gaps.push({ x, w: o.gapW, idleMs: merged[i + 1]![0] - s[1] }); x += o.gapW; }
  });
  const X = (t: number): number => {
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]!;
      if (t <= s.b) return t < s.a ? (i ? gaps[i - 1]!.x + gaps[i - 1]!.w * 0.5 : s.x0) : s.x0 + (s.x1 - s.x0) * (s.b > s.a ? (t - s.a) / weight([s.a, s.b]) : 0);
    }
    return segs[segs.length - 1]!.x1;
  };
  g.order.forEach((id, i) => {
    const n = g.nodes[id]!; const s = spanOf(n, now) ?? [segs[0]!.a, segs[0]!.a];
    const x0 = X(s[0]); const lane: ThreadLane = { id, depth: 0, y: o.top + i * o.lane + o.lane / 2, status: n.status, kind: n.kind, start: s[0], end: s[1], open: isLive(n.status), x0, x1: Math.max(X(s[1]), x0 + 3) };
    if (n.parentId) lane.parent = n.parentId;
    lanes.push(lane);
  });
  const depth = new Map<string, number>();
  for (const l of lanes) { const d = l.parent ? (depth.get(l.parent) ?? 0) + 1 : 0; depth.set(l.id, d); l.depth = d; }
  const multiDay = new Date(segs[0]!.a).toDateString() !== new Date(segs[segs.length - 1]!.b).toDateString();
  const ticks: ThreadTick[] = [];
  segs.forEach((s, i) => {
    ticks.push({ x: s.x0, label: fmtWhen(s.a, multiDay), anchor: 'start' });
    if (i < segs.length - 1 && s.x1 - s.x0 > 110) ticks.push({ x: s.x1, label: fmtWhen(s.b, multiDay), anchor: 'end' });
  });
  const out: ThreadLayout = { lanes, segs, gaps, ticks, height: o.top + lanes.length * o.lane + 4 };
  if (root && isLive(root.status)) out.nowX = segs[segs.length - 1]!.x1;
  return out;
}

// ---------------------------------------------------------------- file names in text

const EXT = 'ts|tsx|js|jsx|mjs|cjs|json|jsonl|md|mdx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|css|scss|less|html|vue|svelte|yml|yaml|toml|ini|cfg|conf|sh|bash|zsh|sql|png|jpe?g|gif|svg|webp|ico|pdf|txt|log|csv|tsv|xml|proto|graphql|tf|lock|env|ipynb';
const ROOTS = 'home|workspaces|Users|tmp|var|etc|opt|usr|mnt|private|root|srv|Volumes';
/**
 * Absolute paths (with an extension, or under a known root — so `/api/autoflow` is not one), relative paths with a
 * folder and a known extension, each with an optional `:line[:col]`. Never inside a URL.
 */
const PATH_RE = new RegExp(
  `(?<![\\w:/.~@-])(?:(\\/(?:[\\w.@+~-]+\\/)+[\\w.@+~-]+\\.(?:${EXT})|\\/(?:${ROOTS})(?:\\/[\\w.@+~-]+)+)|((?:\\.{1,2}\\/)?(?:[\\w@+~-][\\w.@+~-]*\\/)+[\\w@+~-][\\w.@+~-]*\\.(?:${EXT})))(?::(\\d+)(?::\\d+)?)?(?![\\w/])`, 'g');
const BARE_RE = new RegExp(`^[\\w@+~-][\\w.@+~-]*\\.(?:${EXT})(?::(\\d+)(?::\\d+)?)?$`);
export interface PathHit { start: number; end: number; raw: string; path: string; line?: number }
export function findPaths(text: string): PathHit[] {
  const out: PathHit[] = [];
  for (const m of text.matchAll(PATH_RE)) {
    const path = (m[1] ?? m[2] ?? '').replace(/\.+$/, '');          // "see src/a.ts." — the full stop is the sentence's
    if (path.length < 4) continue;
    const raw = m[3] ? m[0] : path;
    const hit: PathHit = { start: m.index!, end: m.index! + raw.length, raw, path };
    if (m[3]) hit.line = Number(m[3]);
    out.push(hit);
  }
  return out;
}
/** A code span that is only a file name (`handler.ts`, `src/a.ts:9`) is a file, not code. */
export function pathOfCode(code: string): { path: string; line?: number } | undefined {
  const t = code.trim();
  const hits = findPaths(t);
  if (hits.length === 1 && hits[0]!.start === 0 && hits[0]!.end === t.length) { const h = hits[0]!; return h.line ? { path: h.path, line: h.line } : { path: h.path }; }
  const b = BARE_RE.exec(t);
  if (b) { const path = t.replace(/:\d+(?::\d+)?$/, ''); return b[1] ? { path, line: Number(b[1]) } : { path }; }
  return undefined;
}

// ---------------------------------------------------------------- Markdown, for prompts and replies

export type Inline =
  | { t: 'text'; v: string } | { t: 'code'; v: string } | { t: 'strong'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] } | { t: 'path'; label: string; path: string; line?: number };
export type MdBlock =
  | { t: 'p'; c: Inline[] } | { t: 'h'; level: number; c: Inline[] } | { t: 'hr' }
  | { t: 'list'; ordered: boolean; start: number; items: Inline[][] } | { t: 'code'; lang: string; v: string }
  | { t: 'quote'; c: MdBlock[] } | { t: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { t: 'tag'; name: string; c: MdBlock[] } | { t: 'insight'; c: MdBlock[] };

/** Plain text with its file names made into file tokens. */
function textWithPaths(s: string): Inline[] {
  const out: Inline[] = []; let at = 0;
  for (const h of findPaths(s)) {
    if (h.start > at) out.push({ t: 'text', v: s.slice(at, h.start) });
    out.push(h.line ? { t: 'path', label: h.raw, path: h.path, line: h.line } : { t: 'path', label: h.raw, path: h.path });
    at = h.end;
  }
  if (at < s.length) out.push({ t: 'text', v: s.slice(at) });
  return out;
}
const isUrl = (h: string): boolean => /^(?:https?:|mailto:)/i.test(h);
/** Inline Markdown: `code`, **bold**, [links](…) — a link or code span that names a file becomes a file token. */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  const re = /`([^`\n]+)`|\*\*([^*\n][^*\n]*?)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let at = 0;
  for (const m of s.matchAll(re)) {
    if (m.index! > at) out.push(...textWithPaths(s.slice(at, m.index)));
    if (m[1] !== undefined) { const p = pathOfCode(m[1]); out.push(p ? { t: 'path', label: m[1], ...p } : { t: 'code', v: m[1] }); }
    else if (m[2] !== undefined) out.push({ t: 'strong', c: parseInline(m[2]) });
    else {
      const href = m[4]!, label = m[3]!;
      if (isUrl(href)) out.push({ t: 'link', href, c: parseInline(label) });
      else { const p = pathOfCode(href.replace(/#L(\d+)(?:-L?\d+)?$/, ':$1')) ?? { path: href.replace(/#.*$/, '') }; out.push({ t: 'path', label, ...p }); }
    }
    at = m.index! + m[0].length;
  }
  if (at < s.length) out.push(...textWithPaths(s.slice(at)));
  return out;
}

const LIST_RE = /^\s{0,6}(?:([-*+])|(\d+)[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const INSIGHT_OPEN = /^`?★ Insight ─+`?\s*$/;
const INSIGHT_CLOSE = /^`?─{8,}`?\s*$/;
const cells = (l: string): string[] => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

/**
 * Prompts and replies as Markdown (D20): headings, lists, fenced code, quotes, tables and rules; a section a
 * prompt fences with a tag on its own line (`<context>` … `</context>`) becomes a labelled box, and the
 * explanatory style's "★ Insight" block a callout. Nothing is reworded — only laid out.
 */
export function parseMarkdown(src: string, depth = 0): MdBlock[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: MdBlock[] = []; let i = 0;
  const startsBlock = (l: string): boolean => /^(#{1,6} |```|>\s?|\s*(?:[-*+]|\d+[.)]) |<[\w-]+>\s*$)/.test(l) || INSIGHT_OPEN.test(l) || /^(?:-{3,}|\*{3,})\s*$/.test(l);
  while (i < lines.length) {
    const l = lines[i]!;
    if (!l.trim()) { i++; continue; }
    const fence = /^\s*```\s*([\w+-]*)/.exec(l);
    if (fence) { const body: string[] = []; i++; while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!); i++; out.push({ t: 'code', lang: fence[1] ?? '', v: body.join('\n') }); continue; }
    if (INSIGHT_OPEN.test(l)) { const body: string[] = []; i++; while (i < lines.length && !INSIGHT_CLOSE.test(lines[i]!)) body.push(lines[i++]!); i++; out.push({ t: 'insight', c: parseMarkdown(body.join('\n'), depth + 1) }); continue; }
    const tag = /^<([\w-]+)>\s*$/.exec(l);
    if (tag && depth < 4) {
      const close = lines.findIndex((x, j) => j > i && x.trim() === `</${tag[1]}>`);
      if (close > i) { out.push({ t: 'tag', name: tag[1]!, c: parseMarkdown(lines.slice(i + 1, close).join('\n'), depth + 1) }); i = close + 1; continue; }
    }
    const hd = /^(#{1,6})\s+(.*)$/.exec(l);
    if (hd) { out.push({ t: 'h', level: hd[1]!.length, c: parseInline(hd[2]!) }); i++; continue; }
    if (/^(?:-{3,}|\*{3,})\s*$/.test(l)) { out.push({ t: 'hr' }); i++; continue; }
    if (/^>\s?/.test(l)) { const body: string[] = []; while (i < lines.length && /^>\s?/.test(lines[i]!)) body.push(lines[i++]!.replace(/^>\s?/, '')); out.push({ t: 'quote', c: parseMarkdown(body.join('\n'), depth + 1) }); continue; }
    if (l.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      const head = cells(l).map(parseInline); i += 2; const rows: Inline[][][] = [];
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) rows.push(cells(lines[i++]!).map(parseInline));
      out.push({ t: 'table', head, rows }); continue;
    }
    const li = LIST_RE.exec(l);
    if (li) {
      const ordered = !!li[2]; const items: string[] = []; const start = ordered ? Number(li[2]) : 1;
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]!);
        if (m && !!m[2] === ordered) { items.push(m[3]!); i++; continue; }
        if (lines[i]!.trim() && /^\s{2,}/.test(lines[i]!) && items.length && !m) { items[items.length - 1] += `\n${lines[i]!.trim()}`; i++; continue; }
        break;
      }
      out.push({ t: 'list', ordered, start, items: items.map(parseInline) }); continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !(para.length && startsBlock(lines[i]!))) para.push(lines[i++]!);
    out.push({ t: 'p', c: parseInline(para.join('\n')) });
  }
  return out;
}

// ---------------------------------------------------------------- JSON views

export type JsonView = 'formatted' | 'pretty' | 'raw';
/** Past this many characters a JSON value opens as the dump, so a huge output never stalls the view (D20). */
export const JSON_BIG = 100 * 1024;
/** A cheap test before any parse: the text is one JSON object or array. */
export const looksJson = (text: string): boolean => { const t = text.trim(); return t.length > 1 && ((t[0] === '{' && t[t.length - 1] === '}') || (t[0] === '[' && t[t.length - 1] === ']')); };
export interface Finding { severity?: string; title?: string; file?: string; line?: number | string; evidence?: string; failure_scenario?: string }
export interface Findings { verdict?: string; findings: Finding[] }
/** A shape the reader knows how to show as more than JSON: a verdict with findings (StructuredOutput reviews). */
export function recognise(v: unknown): Findings | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.findings) || !o.findings.every(f => f && typeof f === 'object' && !Array.isArray(f) && ('title' in f || 'severity' in f || 'evidence' in f))) return undefined;
  return { ...(typeof o.verdict === 'string' ? { verdict: o.verdict } : {}), findings: o.findings as Finding[] };
}
/** Which view a JSON value opens in: what you last chose for that tool, else Formatted when known, else Pretty; the dump past JSON_BIG. */
export function defaultView(size: number, formattable: boolean, chosen: JsonView | undefined): JsonView {
  if (size > JSON_BIG) return 'raw';
  if (chosen && (chosen !== 'formatted' || formattable)) return chosen;
  return formattable ? 'formatted' : 'pretty';
}
