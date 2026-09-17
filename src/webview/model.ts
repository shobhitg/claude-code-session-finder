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
  /** how expensive the next turn is: context size against the model's window */
  heat?: Heat;
}
export interface Heat { tokens: number; window: number; pct: number; tier: 'low' | 'mid' | 'high'; label: string; title: string }
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

export const fmtTokens = (n: number): string => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

/** The model's context window. Explicit `[1m]` variants and the Fable family run 1M; everything else 200k. */
export function contextWindow(model?: string, tokens = 0): number {
  const m = model ?? '';
  const w = /\[1m\]/i.test(m) || /fable/i.test(m) ? 1_000_000 : 200_000;
  return tokens > w ? 1_000_000 : w;                          // never show more than full
}

/**
 * Cost meter for a row. Green under half the window, yellow to three quarters, red above: past that,
 * every turn re-sends a near-full context and compaction is close.
 */
export function heatOf(tokens: number, model?: string): Heat {
  const window = contextWindow(model, tokens);
  const pct = Math.min(100, Math.round((tokens / window) * 100));
  const tier = pct < 50 ? 'low' : pct < 75 ? 'mid' : 'high';
  return { tokens, window, pct, tier, label: fmtTokens(tokens),
           title: `Context ${fmtTokens(tokens)} of ${fmtTokens(window)} tokens (${pct}%) — what each turn costs${tier === 'high' ? '; compaction is near' : ''}` };
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
  if (r.contextTokens) vm.heat = heatOf(r.contextTokens, r.model);
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
 * Keep rows where they are. The host orders each urgency group by last write, so two running sessions
 * swap every time one of them writes. Within each contiguous group of equal state the rows are ordered
 * by first appearance instead (higher `seen` = newer = higher up); a row moves only when its state
 * changes. Link rows stay put.
 */
export function stableOrder(rows: Array<RowVM | LinkVM>, seen: ReadonlyMap<string, number>): Array<RowVM | LinkVM> {
  const out: Array<RowVM | LinkVM> = [];
  let group: RowVM[] = []; let key: string | null = null;
  const flush = (): void => {
    out.push(...group.sort((a, b) => (seen.get(b.sessionId) ?? 0) - (seen.get(a.sessionId) ?? 0)));
    group = [];
  };
  for (const r of rows) {
    if (r.kind === 'link') { flush(); key = null; out.push(r); continue; }
    const k = `${r.state}/${r.reason ?? ''}`;
    if (k !== key) { flush(); key = k; }
    group.push(r);
  }
  flush();
  return out;
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
