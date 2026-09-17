import type { SearchIndex, SessionMeta } from './types.js';
import type { Liveness, AttentionReason } from './state.js';
import { isLocalCommand } from './transcript.js';

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
      if (p.r !== 'u' || isLocalCommand(p.x)) continue;   // a /clear or /model echo is not what the session is about
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
