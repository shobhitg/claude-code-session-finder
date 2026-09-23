import type { Liveness } from './state.js';

/**
 * Closing a session (the × on an ACTIVE row) puts it under CLOSED even though its transcript was
 * written recently. The override is a marker — session id → the moment of the close — and it holds
 * while nothing has written the transcript AFTER the close. Claude Code shuts the session down
 * when its tab closes, and that shutdown may write once more; `CLOSE_GRACE_MS` lets that write
 * through. Anything later (you resumed the session and sent a message) is real activity, and the
 * session is ACTIVE again with no marker.
 */
export const CLOSE_GRACE_MS = 10_000;

/** sessionId → closedAt (ms since epoch). Persisted as-is in globalState. */
export type ClosedMarkers = Readonly<Record<string, number>>;

export function isClosed(closedAt: number | undefined, lastWriteMs: number, graceMs = CLOSE_GRACE_MS): boolean {
  return closedAt !== undefined && lastWriteMs <= closedAt + graceMs;
}

export interface ApplyClosedOpts { now: number; activeWindowMs: number; graceMs?: number }
export interface ApplyClosedResult {
  /** `liveness` without the sessions that are closed */
  liveness: Map<string, Liveness>;
  /** the markers still worth keeping; `changed` says whether they differ from what came in */
  markers: ClosedMarkers;
  changed: boolean;
}

/**
 * Split liveness into what still counts as live and prune the markers that no longer matter:
 * one whose session was written after the grace (it is ACTIVE again), and one older than the
 * active window plus the grace (its session cannot be in the window any more, whether or not the
 * tracker has swept yet — so a marker for a session the tracker has not seen is kept until then).
 */
export function applyClosed(liveness: ReadonlyMap<string, Liveness>, markers: ClosedMarkers, opts: ApplyClosedOpts): ApplyClosedResult {
  const grace = opts.graceMs ?? CLOSE_GRACE_MS;
  const kept: Record<string, number> = {};
  let changed = false;
  for (const [id, at] of Object.entries(markers)) {
    const l = liveness.get(id);
    const valid = typeof at === 'number' && Number.isFinite(at);
    const keep = valid && opts.now - at <= opts.activeWindowMs + grace && (!l || isClosed(at, l.lastWriteMs, grace));
    if (keep) kept[id] = at; else changed = true;
  }
  const out = new Map<string, Liveness>();
  for (const [id, l] of liveness) if (!isClosed(kept[id], l.lastWriteMs, grace)) out.set(id, l);
  return { liveness: out, markers: kept, changed };
}
