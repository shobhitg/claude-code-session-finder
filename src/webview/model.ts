import { stateIcon, stateLabel, type Snapshot, type LiveRow, type HistoryRow, type SearchRow } from '../core/rows.js';

export interface RowVM {
  kind: 'session'; sessionId: string; title: string; meta: string; time: string; iconClass: string;
  state: 'running' | 'attention' | 'history'; reason?: string; missing: boolean;
  /** the best-matching line, on a filter result */
  snippet?: string;
  /** the session behind the active editor tab */
  selected: boolean;
  /** one sentence for the glyph's tooltip */
  stateLabel: string;
}
export interface LinkVM { kind: 'link'; title: string; meta: string; iconClass: string; action: 'search' | 'scope' }
export interface SectionVM {
  id: 'active' | 'history' | 'results'; label: string; count: number; rows: Array<RowVM | LinkVM>;
  empty: string | null; skeleton: boolean;
}
export interface ViewModel { sections: SectionVM[] }
export interface ViewOpts { activeWindowLabel: string; searchKey: string; reducedMotion?: boolean; activeId?: string | null }

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
export function timeLabel(row: Pick<LiveRow, 'state' | 'reason' | 'lastWriteMs'>, now: number): string {
  const quiet = now - row.lastWriteMs;
  if (row.state === 'running') return quiet < 45_000 ? 'just now' : `quiet ${fmtDuration(quiet)}`;
  switch (row.reason) {
    case 'tool-or-permission': return `quiet ${fmtDuration(quiet)}`;
    case 'question': return `asks you · ${fmtDuration(quiet)}`;
    case 'your-turn': return `done · ${fmtDuration(quiet)} ago`;
    case 'interrupted': return `interrupted · ${fmtDuration(quiet)}`;
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

// Under reduced motion the spinner becomes a static dot in the running colour (spec §10).
const runningIcon = (reducedMotion?: boolean): string => reducedMotion ? 'circle-large-filled' : 'loading~spin';

function liveRow(r: LiveRow, now: number, opts: ViewOpts): RowVM {
  const vm: RowVM = {
    kind: 'session', sessionId: r.sessionId, title: r.title, meta: metaLabel(r), time: timeLabel(r, now),
    iconClass: iconClass(r.state === 'running' ? runningIcon(opts.reducedMotion) : stateIcon(r)), state: r.state,
    missing: !r.cwdExists, selected: r.sessionId === opts.activeId, stateLabel: stateLabel(r),
  };
  if (r.reason) vm.reason = r.reason;
  return vm;
}

function historyRow(r: HistoryRow, opts: ViewOpts): RowVM {
  return {
    kind: 'session', sessionId: r.sessionId, title: r.title, meta: metaLabel(r), time: historyLabel(r),
    iconClass: iconClass('history'), state: 'history', missing: !r.cwdExists, selected: r.sessionId === opts.activeId,
    stateLabel: 'Finished earlier',
  };
}

export function viewModel(s: Snapshot, now: number, opts: ViewOpts): ViewModel {
  const active: RowVM[] = s.active.map(r => liveRow(r, now, opts));
  const history: Array<RowVM | LinkVM> = s.history.map(r => historyRow(r, opts));
  if (!s.indexing) {
    history.push({ kind: 'link', title: `Search all ${s.totalSessions} sessions…`, meta: opts.searchKey,
                   iconClass: iconClass('search'), action: 'search' });
    history.push(s.scope === 'workspace'
      ? { kind: 'link', title: 'This workspace only · show all projects', meta: '', iconClass: iconClass('filter-filled'), action: 'scope' }
      : { kind: 'link', title: 'All projects · show this workspace only', meta: '', iconClass: iconClass('filter'), action: 'scope' });
  }

  const historyCount = Math.max(0, s.totalSessions - s.active.length);
  return {
    sections: [
      { id: 'active', label: 'Active', count: active.length, rows: active, skeleton: false,
        empty: active.length ? null : `Nothing running${s.scope === 'workspace' ? ' in this workspace' : ''}. Sessions touched in the last ${opts.activeWindowLabel} appear here.` },
      { id: 'history', label: 'History', count: historyCount, rows: history,
        skeleton: s.indexing && history.length === 0, empty: null },
    ],
  };
}

/**
 * The list while the inline filter has text: one RESULTS section in place of ACTIVE and HISTORY.
 * Rows keep their live glyph and time so a running match still reads as running; each carries the
 * matching line. `rows === null` means the host has not answered yet (skeleton).
 */
export function resultsModel(
  rows: SearchRow[] | null, q: string, deep: boolean, now: number, opts: ViewOpts,
): ViewModel {
  const vms: RowVM[] = (rows ?? []).map(r => {
    const vm: RowVM = r.live
      ? liveRow({ ...r, state: r.live.state, lastWriteMs: r.live.lastWriteMs, ...(r.live.reason ? { reason: r.live.reason } : {}) }, now, opts)
      : historyRow(r, opts);
    if (r.snippet) vm.snippet = r.snippet;
    return vm;
  });
  const empty = rows === null ? null
    : deep ? `Deep (!) searches read whole transcripts — run them in the picker (${opts.searchKey}).`
    : vms.length ? null : `No sessions match “${q.trim()}”.`;
  return { sections: [{ id: 'results', label: 'Results', count: vms.length, rows: vms, skeleton: rows === null && !deep, empty }] };
}
