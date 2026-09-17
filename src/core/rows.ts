import type { SearchIndex, SessionMeta } from './types.js';
import type { Liveness, AttentionReason } from './state.js';
import { isLocalCommand } from './transcript.js';
import { snippet, type SessionHit } from './query.js';

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
export type SidebarScope = 'workspace' | 'all';
export interface Snapshot { active: LiveRow[]; history: HistoryRow[]; totalSessions: number; indexing: boolean; scope: SidebarScope }
/** A row of the sidebar's inline filter: a HISTORY-shaped row plus what matched, and its live state if it has one. */
export interface SearchRow extends HistoryRow {
  snippet: string | null; matches: number;
  live?: { state: 'running' | 'attention'; reason?: AttentionReason; lastWriteMs: number };
}

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

/** First real prompt per session — the title fallback every surface shares. */
export function firstPrompts(index: SearchIndex): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of index.prose) {                       // file order, so the first 'u' per session is the first prompt
    if (p.r !== 'u' || isLocalCommand(p.x)) continue;   // a /clear or /model echo is not what the session is about
    const id = index.sessions[p.s]?.sessionId;
    if (id && !out.has(id)) out.set(id, p.x);
  }
  return out;
}

/** Search hits as sidebar rows: same titles as the list, the best-matching line as a snippet, live state kept. */
export function rowsForHits(hits: SessionHit[], liveness: ReadonlyMap<string, Liveness>, firstPrompt: Map<string, string>, limit = 50): SearchRow[] {
  return hits.slice(0, limit).map(h => {
    const m = h.session; const l = liveness.get(m.sessionId);
    const row: SearchRow = {
      sessionId: m.sessionId, title: titleOf(m, m.sessionId, firstPrompt), project: projectLabel(m.projectDir),
      branch: m.branches.at(-1) ?? null, pr: m.prLinks.at(-1) ?? null, cwdExists: m.cwdExists, lastTs: m.lastTs, msgCount: m.msgCount,
      snippet: h.best ? snippet(h.best.text, h.best.index) : null, matches: h.matchCount,
    };
    if (l) row.live = { state: l.state.kind, lastWriteMs: l.lastWriteMs, ...(l.state.kind === 'attention' ? { reason: l.state.reason } : {}) };
    return row;
  });
}

/**
 * Which row a Claude Code editor tab points at. Claude Code titles its tab with the session's
 * title, so an exact title match wins, ACTIVE before HISTORY; a prefix match covers a truncated
 * label. Nothing matches → undefined, and the sidebar highlights nothing rather than guessing.
 */
export function resolveTabSession(label: string, s: Snapshot): string | undefined {
  const l = label.trim(); if (!l) return undefined;
  const rows = [...s.active, ...s.history];
  return (rows.find(r => r.title === l) ?? rows.find(r => r.title.startsWith(l) || l.startsWith(r.title)))?.sessionId;
}

export function buildSnapshot(
  index: SearchIndex | null,
  liveness: ReadonlyMap<string, Liveness>,
  opts: { historyLimit?: number; indexing?: boolean; scope?: SidebarScope; inScope?: (m: SessionMeta) => boolean } = {},
): Snapshot {
  const limit = opts.historyLimit ?? 50;
  const byId = new Map<string, SessionMeta>();
  const firstPrompt = index ? firstPrompts(index) : new Map<string, string>();
  if (index) for (const s of index.sessions) byId.set(s.sessionId, s);

  // Scope: a session the index knows and the predicate rejects is another project's. A live session
  // the index has not seen yet stays — it is probably this window's newest, and hiding it would be worse.
  const keep = (m: SessionMeta | undefined): boolean => !m || !opts.inScope || opts.inScope(m);
  const scoped = (index?.sessions ?? []).filter(keep);

  const active: LiveRow[] = [...liveness.values()]
    .filter(l => keep(byId.get(l.sessionId)))
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

  const history: HistoryRow[] = scoped
    .filter(s => !liveness.has(s.sessionId))
    .sort((a, b) => b.lastTs - a.lastTs)
    .slice(0, limit)
    .map(m => ({
      sessionId: m.sessionId, title: titleOf(m, m.sessionId, firstPrompt), project: projectLabel(m.projectDir),
      branch: m.branches.at(-1) ?? null, pr: m.prLinks.at(-1) ?? null, cwdExists: m.cwdExists,
      lastTs: m.lastTs, msgCount: m.msgCount,
    }));

  return { active, history, totalSessions: scoped.length, indexing: opts.indexing ?? false, scope: opts.scope ?? 'all' };
}
