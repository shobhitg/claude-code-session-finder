import { stateIcon, type Snapshot, type LiveRow, type HistoryRow } from '../core/rows.js';

export interface RowVM {
  kind: 'session'; sessionId: string; title: string; meta: string; time: string; iconClass: string;
  state: 'running' | 'attention' | 'history'; reason?: string; missing: boolean;
}
export interface LinkVM { kind: 'link'; title: string; meta: string; iconClass: string; action: 'search' }
export interface SectionVM {
  id: 'active' | 'history'; label: string; count: number; rows: Array<RowVM | LinkVM>;
  empty: string | null; skeleton: boolean;
}
export interface ViewModel { sections: SectionVM[] }

/** `loading~spin` → `codicon codicon-loading codicon-modifier-spin` (the IDE's own spinner). */
export function iconClass(name: string): string {
  const [base, mod] = name.split('~');
  return `codicon codicon-${base}${mod ? ` codicon-modifier-${mod}` : ''}`;
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} m`;
  const h = ms / 3_600_000;
  if (h < 48) return `${h.toFixed(1).replace(/\.0$/, '')} h`;
  return `${Math.round(h / 24)} d`;
}

/** Spec §10 table, "Time label" column. */
export function timeLabel(row: LiveRow, now: number): string {
  const quiet = now - row.lastWriteMs;
  if (row.state === 'running') return quiet < 45_000 ? 'just now' : `quiet ${fmtDuration(quiet)}`;
  switch (row.reason) {
    case 'tool-or-permission': return `quiet ${fmtDuration(quiet)}`;
    case 'your-turn': return `${fmtDuration(quiet)} ago`;
    default: return fmtDuration(quiet);
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function historyLabel(row: HistoryRow): string {
  const d = new Date(row.lastTs);
  return `${MONTHS[d.getMonth()]} ${d.getDate()} · ${row.msgCount} msgs`;
}

export function metaLabel(r: { project: string; branch: string | null; pr: number | null }): string {
  return [r.project, r.branch ?? '', r.pr ? `PR #${r.pr}` : ''].filter(Boolean).join(' · ');
}

export function viewModel(
  s: Snapshot, now: number,
  opts: { activeWindowLabel: string; searchKey: string; reducedMotion?: boolean },
): ViewModel {
  // Under reduced motion the spinner becomes a static dot in the running colour (spec §10).
  const runningIcon = opts.reducedMotion ? 'circle-large-filled' : 'loading~spin';

  const active: RowVM[] = s.active.map(r => {
    const vm: RowVM = {
      kind: 'session', sessionId: r.sessionId, title: r.title, meta: metaLabel(r), time: timeLabel(r, now),
      iconClass: iconClass(r.state === 'running' ? runningIcon : stateIcon(r)), state: r.state, missing: !r.cwdExists,
    };
    if (r.reason) vm.reason = r.reason;
    return vm;
  });

  const history: Array<RowVM | LinkVM> = s.history.map(r => ({
    kind: 'session', sessionId: r.sessionId, title: r.title, meta: metaLabel(r), time: historyLabel(r),
    iconClass: iconClass('history'), state: 'history', missing: !r.cwdExists,
  }));
  if (!s.indexing) {
    history.push({ kind: 'link', title: `Search all ${s.totalSessions} sessions…`, meta: opts.searchKey,
                   iconClass: iconClass('search'), action: 'search' });
  }

  const historyCount = Math.max(0, s.totalSessions - s.active.length);
  return {
    sections: [
      { id: 'active', label: 'Active', count: active.length, rows: active, skeleton: false,
        empty: active.length ? null : `Nothing running. Sessions touched in the last ${opts.activeWindowLabel} appear here.` },
      { id: 'history', label: 'History', count: historyCount, rows: history,
        skeleton: s.indexing && history.length === 0, empty: null },
    ],
  };
}
