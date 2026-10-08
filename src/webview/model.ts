import { stateIcon, stateLabel, type Snapshot, type LiveRow, type HistoryRow, type SearchRow, type RowWhere, type PrState } from '../core/rows.js';
import { isDefaultBranch, sameAsBranch } from '../core/links.js';

export interface RowVM {
  kind: 'session'; sessionId: string; title: string; time: string; iconClass: string;
  /** what the time measures, for its tooltip — none on a closed row */
  timeTip?: string;
  state: 'running' | 'attention' | 'history'; reason?: string;
  /** its folder is gone, and no worktree says so */
  missing: boolean;
  /** line 2: where the work is */
  where: WhereVM;
  /** PRs newest first, then Slack threads — buttons that open them */
  links: ChipVM[];
  /** the best-matching line, on a filter result */
  snippet?: string;
  /** the session behind the active editor tab */
  selected: boolean;
  /** one sentence for the glyph's tooltip */
  stateLabel: string;
  /** how expensive the next turn is: context size against the model's window */
  heat?: Heat;
  /** written longer ago than the active window — here only because its tab is open */
  age?: AgeTag;
  /** the bell (D13): the ball is in your court and you have not seen it there — the needs-you look */
  ringing?: true;
  /** a headless run (D15): the ghost takes the icon slot and this is its dot — none on a closed row */
  ghost?: GhostStatus;
}
export type GhostStatus = 'running' | 'done' | 'failed' | 'waiting' | 'stalled' | 'closed';
export interface AgeTag { label: string; title: string; tier: 'old' | 'stale' }
export interface WhereVM {
  /** only a session from another project names it */
  project?: { label: string; tip: string };
  /** quiet: main or a detached HEAD, where no work was done */
  branch?: { label: string; tip: string; quiet?: true };
  /** only when its name says something the branch doesn't, or its folder is gone */
  worktree?: { label: string; tip: string; gone?: true };
}
export interface ChipVM {
  kind: 'pr' | 'slack'; url: string;
  /** `#21264`; empty for Slack, which is an icon only */
  label: string;
  /** a codicon name, or `slack` for the Slack mark main.ts draws */
  icon: string;
  state?: PrState;
  tip: string; aria: string;
  /** its line in the list behind +N: a PR's title (else its branch), what you wrote with a Slack link (else when) */
  detail: string;
}
export type HeatTier = 'low' | 'mid' | 'warm' | 'high' | 'full';
export interface Heat { tokens: number; budget: number; pct: number; tier: HeatTier; label: string; title: string }
export interface LinkVM { kind: 'link'; title: string; meta: string; iconClass: string; action: 'search' | 'scope' | 'headless'; ghost?: true }
export interface SectionVM {
  id: 'active' | 'history' | 'results'; label: string; count: number; rows: Array<RowVM | LinkVM>;
  empty: string | null; skeleton: boolean;
}
export interface ViewModel { sections: SectionVM[] }
export interface ViewOpts { activeWindowLabel: string; activeWindowMs?: number; searchKey: string; reducedMotion?: boolean; activeId?: string | null; contextBudget?: number }

/** `loading~spin` → `codicon codicon-loading codicon-modifier-spin` (the IDE's own spinner). */
export function iconClass(name: string): string {
  const [base, mod] = name.split('~');
  return `codicon codicon-${base}${mod ? ` codicon-modifier-${mod}` : ''}`;
}

/** The two largest units, no space inside a unit: "40s", "3m", "2h 6m", "2d 1h". Rounded to the minute, then split. */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  if (m < 24 * 60) return pair(Math.floor(m / 60), 'h', m % 60, 'm');
  const h = Math.floor(m / 60);
  return pair(Math.floor(h / 24), 'd', h % 24, 'h');
}
const pair = (a: number, au: string, b: number, bu: string): string => b ? `${a}${au} ${b}${bu}` : `${a}${au}`;

type TimedRow = Pick<LiveRow, 'state' | 'reason' | 'lastWriteMs' | 'headless'>;

/**
 * Spec §10 table, "Time label" column: what the session is doing, in the words you would use, then how long
 * since it last wrote. "quiet 5m" (until 0.10.1) answered neither "is it working?" nor "does it need me?".
 * A tool call quiet past toolQuietSeconds is a permission prompt or a long command, which nothing on disk
 * tells apart (L4) — so it *may* need you; a headless run cannot stop for a prompt, so it is working (D15).
 */
export function timeLabel(row: TimedRow, now: number): string {
  const quiet = now - row.lastWriteMs;
  const working = quiet < 45_000 ? 'working' : `working · ${fmtDuration(quiet)}`;
  if (row.state === 'running') return working;
  switch (row.reason) {
    case 'tool-or-permission': return row.headless ? working : `may need you · ${fmtDuration(quiet)}`;
    case 'question': return `asks you · ${fmtDuration(quiet)}`;
    case 'your-turn': return `done · ${fmtDuration(quiet)} ago`;
    case 'interrupted': return `interrupted · ${fmtDuration(quiet)}`;
    default: return `stalled · ${fmtDuration(quiet)}`;
  }
}

/** The time label's tooltip: what its number measures, which the label is too short to say. */
export function timeTip(row: TimedRow, now: number): string {
  const d = fmtDuration(now - row.lastWriteMs);
  if (row.state === 'running') return `Claude is working — last wrote ${d} ago`;
  switch (row.reason) {
    case 'tool-or-permission': return row.headless
      ? `In a tool call for ${d} — a headless run cannot stop for a permission prompt, so it is still working`
      : `In a tool call for ${d}: a permission prompt waiting on you, or a long command still running`;
    case 'question': return `Claude asked ${d} ago and is waiting for your answer`;
    case 'your-turn': return `Claude finished ${d} ago — your turn`;
    case 'interrupted': return `Interrupted ${d} ago — waiting for you`;
    default: return `Nothing written for ${d} — it may have died`;
  }
}

const WINDOW_UNITS: Record<string, string> = { h: 'hour', d: 'day', w: 'week', m: 'month' };
/** "4h" → "4 hours": the activeWindow setting spelled out, for the age tag. Anything unparseable is shown as typed. */
export function fmtWindow(spec: string): string {
  const m = /^(\d+)\s*([hdwm])?$/.exec(spec.trim().toLowerCase());
  if (!m) return spec;
  const n = Number(m[1]); const unit = WINDOW_UNITS[m[2] ?? 'd'] ?? 'day';
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * An ACTIVE session quiet for longer than the window is there only because its tab is open. A standing
 * tag says how long — whole hours, then days and hours ("> 19h", "> 2d 1h") — in place of the corner
 * time it would duplicate (the tooltip keeps that label), orange, and red once it is a day old. The user
 * closes it on purpose.
 */
export function ageTag(row: TimedRow, now: number, opts: ViewOpts): AgeTag | undefined {
  const quiet = now - row.lastWriteMs;
  if (!opts.activeWindowMs || quiet <= opts.activeWindowMs) return undefined;
  const hours = Math.floor(quiet / 3_600_000);
  return { label: `> ${hours >= 24 ? pair(Math.floor(hours / 24), 'd', hours % 24, 'h') : `${hours}h`}`, tier: hours >= 24 ? 'stale' : 'old',
           title: `${timeLabel(row, now)} — more than ${fmtWindow(opts.activeWindowLabel)} since anything happened here; it is listed because its tab is open. Press × or close the tab to move it under Closed.` };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** The day you last touched it — CLOSED's order (D14), so the dates read in order — and its size. */
export function historyLabel(row: HistoryRow): string {
  const d = new Date(row.touchedTs);
  return `${MONTHS[d.getMonth()]} ${d.getDate()} · ${row.msgCount} msgs`;
}

/** "Oct 8, 01:00": when a link was made, in local time. */
export function fmtWhen(ts: number): string {
  const d = new Date(ts);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const onBranch = (b: string): string => b === 'HEAD' ? 'a detached HEAD' : b;

/** Line 2: the branch first — it says most — then the worktree when it adds something, and the project only when it is not this window's. */
export function whereVM(r: RowWhere & { cwdExists: boolean }): WhereVM {
  const vm: WhereVM = {};
  if (r.elsewhere && r.project) vm.project = { label: r.project, tip: `From ${r.project}, not this window's workspace` };
  const b = r.branch;
  if (b) {
    vm.branch = isDefaultBranch(b)
      ? { label: b === 'HEAD' ? 'detached HEAD' : b, tip: `On ${onBranch(b)} the whole session`, quiet: true }
      : { label: b, tip: `Branch ${b}${r.branchNow && r.branchNow !== b ? `\nNow on ${onBranch(r.branchNow)}` : ''}` };
  }
  const w = r.worktree;
  if (w && !r.cwdExists) vm.worktree = { label: w.name, tip: `Worktree ${w.path} — its folder is gone, so a click opens the transcript instead`, gone: true };
  else if (w && !sameAsBranch(w.name, b)) vm.worktree = { label: w.name, tip: `Worktree ${w.path}` };
  return vm;
}

const PR_ICON: Record<PrState, string> = { open: 'git-pull-request', merged: 'git-merge', closed: 'git-pull-request-closed', draft: 'git-pull-request-draft' };

/** The links: each PR (newest first), then each Slack thread you pasted. */
export function linksVM(r: Pick<RowWhere, 'prs' | 'slack'>): ChipVM[] {
  const prs = r.prs.map((p): ChipVM => {
    const tip = [`PR #${p.n}${p.state ? ` · ${p.state}` : ''}`, p.title ?? '',
                 [p.repo ?? '', p.branch ? `from ${p.branch}` : ''].filter(Boolean).join(' · '),
                 `Linked ${fmtWhen(p.ts)} — click to open on GitHub`].filter(Boolean).join('\n');
    return { kind: 'pr', url: p.url, label: `#${p.n}`, icon: p.state ? PR_ICON[p.state] : 'git-pull-request', ...(p.state ? { state: p.state } : {}),
             tip, aria: `PR #${p.n}${p.state ? `, ${p.state}` : ''}${p.title ? `: ${p.title}` : ''}`,
             detail: p.title ?? (p.branch ? `from ${p.branch}` : p.repo ?? '') };
  });
  const slack = r.slack.map((s): ChipVM => ({
    kind: 'slack', url: s.url, label: '', icon: 'slack',
    tip: [`Slack thread you pasted ${fmtWhen(s.ts)}`, s.said ? `“${s.said}”` : '', 'Click to open in Slack'].filter(Boolean).join('\n'),
    aria: `Slack thread you pasted ${fmtWhen(s.ts)}`,
    detail: s.said ? `“${s.said}”` : `pasted ${fmtWhen(s.ts)}`,
  }));
  return [...prs, ...slack];
}

/**
 * The +N at the end of a row's links: how many folded, and — in its tooltip — what they are, so a row with
 * nine PRs says "6 more PRs (5 merged, 1 closed)" without a click. Nothing folded, no +N.
 */
export function moreLabel(folded: Array<{ kind: 'pr' | 'slack'; state?: string }>): { text: string; tip: string } | undefined {
  if (!folded.length) return undefined;
  const prs = folded.filter(f => f.kind === 'pr'), threads = folded.length - prs.length;
  const states = (['open', 'draft', 'merged', 'closed'] as const)
    .map(s => [s, prs.filter(p => p.state === s).length] as const).filter(([, n]) => n > 0);
  const known = states.reduce((t, [, n]) => t + n, 0);
  const breakdown = states.length === 1 && known === prs.length ? states[0]![0]      // all one state: "(merged)"
    : states.map(([s, n]) => `${n} ${s}`).join(', ');                                 // else each known state, counted
  const prPart = prs.length ? `${prs.length} more PR${prs.length === 1 ? '' : 's'}${breakdown ? ` (${breakdown})` : ''}` : '';
  const slackPart = threads ? `${threads}${prs.length ? '' : ' more'} Slack thread${threads === 1 ? '' : 's'}` : '';
  return { text: `+${folded.length}`, tip: `${[prPart, slackPart].filter(Boolean).join(' and ')} — click to list every link` };
}

/** Line 2, the links, and whether the folder is gone with nothing else to say so. */
function whereAndLinks(r: RowWhere & { cwdExists: boolean }): Pick<RowVM, 'where' | 'links' | 'missing'> {
  const where = whereVM(r);
  return { where, links: linksVM(r), missing: !r.cwdExists && !where.worktree?.gone };
}

export const fmtTokens = (n: number): string => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

export const DEFAULT_CONTEXT_BUDGET = 1_000_000;

/**
 * Cost meter for a row, on ONE absolute scale for every session: a 420k context is a 420k context
 * whichever model holds it. `budget` is where compaction lands (a setting; 1M by default). The ramp
 * is green → yellow → orange → red, and past the budget the bar is pinned full in deep red: the
 * message is "compact or start a new session", and it stays on until you do.
 */
export function heatOf(tokens: number, budget = DEFAULT_CONTEXT_BUDGET): Heat {
  const b = Math.max(1, budget);
  const ratio = tokens / b;
  const pct = Math.min(100, Math.round(ratio * 100));
  const tier: HeatTier = ratio >= 1 ? 'full' : ratio >= 0.8 ? 'high' : ratio >= 0.6 ? 'warm' : ratio >= 0.35 ? 'mid' : 'low';
  const advice = tier === 'full' ? ' — past the budget: compact or start a new session'
    : tier === 'high' ? ' — compaction is near; consider compacting or starting fresh'
    : tier === 'warm' ? ' — getting heavy' : '';
  return { tokens, budget: b, pct, tier, label: fmtTokens(tokens),
           title: `Context ${fmtTokens(tokens)} of a ${fmtTokens(b)} budget (${pct}%): the tokens re-sent on every turn${advice}` };
}

/**
 * How tall ACTIVE stands, in px (D14): the most it has held since the view opened, plus a row of room. A session
 * that starts fills the room, one that closes leaves its space, so CLOSED stays where it is as they come and go —
 * without the ten empty rows ACTIVE kept from the start until 0.10.1, a gap that read as a list still loading.
 */
export function activeReserve(heldPx: number, contentPx: number, rowPx: number): number {
  return Math.max(heldPx, Math.ceil(contentPx + rowPx));
}

// Under reduced motion the spinner becomes a static dot in the running colour (spec §10).
const runningIcon = (reducedMotion?: boolean): string => reducedMotion ? 'circle-large-filled' : 'loading~spin';

/**
 * D15: a headless run is a job, not a conversation, so its dot reads like one. `claude -p` cannot stop
 * for a permission prompt, so a quiet tool call is a long tool, still running; "your turn" is a finished
 * run; an interruption stopped it before it finished.
 */
export function ghostStatus(r: Pick<LiveRow, 'state' | 'reason'>): GhostStatus {
  if (r.state === 'running') return 'running';
  switch (r.reason) {
    case 'tool-or-permission': return 'running';
    case 'your-turn': return 'done';
    case 'interrupted': return 'failed';
    case 'question': return 'waiting';
    default: return 'stalled';
  }
}
const GHOST_LABEL: Record<GhostStatus, string> = {
  running: 'working', done: 'finished · click to read it', failed: 'stopped before it finished · click to read it',
  waiting: 'asked a question nobody is there to answer', stalled: 'nothing written for a while — it may have died',
  closed: 'closed · click to read it',
};
const ghostLabel = (g: GhostStatus): string => `Headless run (claude -p) — ${GHOST_LABEL[g]}`;

function liveRow(r: LiveRow, now: number, opts: ViewOpts): RowVM {
  const vm: RowVM = {
    kind: 'session', sessionId: r.sessionId, title: r.title, time: timeLabel(r, now), timeTip: timeTip(r, now), ...whereAndLinks(r),
    iconClass: iconClass(r.state === 'running' ? runningIcon(opts.reducedMotion) : stateIcon(r)), state: r.state,
    selected: r.sessionId === opts.activeId, stateLabel: stateLabel(r),
  };
  if (r.reason) vm.reason = r.reason;
  if (r.contextTokens) vm.heat = heatOf(r.contextTokens, opts.contextBudget);
  const age = ageTag(r, now, opts);
  if (age) vm.age = age;
  if (r.ringing) vm.ringing = true;
  if (r.headless) { vm.ghost = ghostStatus(r); vm.stateLabel = ghostLabel(vm.ghost); }
  return vm;
}

function historyRow(r: HistoryRow, opts: ViewOpts): RowVM {
  const vm: RowVM = {
    kind: 'session', sessionId: r.sessionId, title: r.title, time: historyLabel(r), ...whereAndLinks(r),
    iconClass: iconClass('history'), state: 'history', selected: r.sessionId === opts.activeId,
    stateLabel: 'Closed · click to resume',
  };
  if (r.headless) { vm.ghost = 'closed'; vm.stateLabel = ghostLabel('closed'); }
  return vm;
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
    // D15: hidden is said out loud, with the way back — no link while nothing is hidden.
    if (s.hiddenHeadless > 0) {
      history.push({ kind: 'link', title: `${s.hiddenHeadless} headless run${s.hiddenHeadless === 1 ? '' : 's'} hidden · show`, meta: '',
                     iconClass: '', action: 'headless', ghost: true });
    }
  }

  // HISTORY in the data model (spec §6: everything not ACTIVE) is labelled Closed in the view: the × on an
  // active row puts a session here by closing its tab, and clicking a row here resumes it.
  const historyCount = Math.max(0, s.totalSessions - s.active.length - s.hiddenHeadless);
  return {
    sections: [
      { id: 'active', label: 'Active', count: active.length, rows: active, skeleton: false,
        empty: active.length ? null : `Nothing running${s.scope === 'workspace' ? ' in this workspace' : ''}. Sessions touched in the last ${opts.activeWindowLabel}, or open in a tab, appear here.` },
      { id: 'history', label: 'Closed', count: historyCount, rows: history,
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
      ? liveRow({ ...r, state: r.live.state, lastWriteMs: r.live.lastWriteMs, ...(r.live.reason ? { reason: r.live.reason } : {}), ...(r.live.ringing ? { ringing: true as const } : {}) }, now, opts)
      : historyRow(r, opts);
    if (r.snippet) vm.snippet = r.snippet;
    return vm;
  });
  const empty = rows === null ? null
    : deep ? `Deep (!) searches read whole transcripts — run them in the picker (${opts.searchKey}).`
    : vms.length ? null : `No sessions match “${q.trim()}”.`;
  return { sections: [{ id: 'results', label: 'Results', count: vms.length, rows: vms, skeleton: rows === null && !deep, empty }] };
}
