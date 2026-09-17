import { samePath } from './core/paths.js';
import type { OpenWhere } from './core/open-args.js';

export interface Baton { sessionId: string; targetCwd: string; expiresAt: number; where?: OpenWhere }

export function claimBaton(raw: string | null, myFolder: string | undefined, now: number):
  { claim: Baton } | { discard: true } | { leave: true } {
  if (!raw) return { discard: true };
  let b: Baton;
  try { b = JSON.parse(raw) as Baton; } catch { return { discard: true }; }
  if (typeof b?.sessionId !== 'string' || typeof b?.targetCwd !== 'string') return { discard: true };
  if (!(b.expiresAt > now)) return { discard: true };
  // Spec §11: the target window honours the requested panel. Anything but a known value is
  // dropped, so a hand-written or older baton behaves like 0.1.x (a tab).
  if (b.where !== 'tab' && b.where !== 'right') delete b.where;
  if (!myFolder) return { leave: true };
  // MUST use samePath, not ===. On macOS the planner may hand off to a differently
  // cased or NFD spelling of the same folder; a strict compare would silently no-op.
  return samePath(b.targetCwd, myFolder) ? { claim: b } : { leave: true };
}

export interface ClaimDeps {
  read: () => Promise<string | null>;
  /** Runs BEFORE the session is opened, so the baton stays single-use even if two windows race. */
  remove: () => Promise<void>;
  openSession: (sessionId: string, where: OpenWhere) => Promise<void>;
  myFolder: string | undefined;
  now?: number;
}

/**
 * I2: the hand-off's GOOD outcome — openFolder focusing a window that is already open —
 * never fires activate() again, so a claim hung solely on activate() silently does
 * nothing. This is the whole claim sequence, callable from activate() AND from a watcher
 * on the baton file, with the invariants (delete-before-open, TTL, samePath) in one place.
 */
export async function claimPendingOpen(deps: ClaimDeps): Promise<'claimed' | 'discarded' | 'left'> {
  const raw = await deps.read();
  const outcome = claimBaton(raw, deps.myFolder, deps.now ?? Date.now());
  if ('leave' in outcome) return 'left';
  await deps.remove();                                // DELETE FIRST — makes the baton single-use
  if ('discard' in outcome) return 'discarded';
  await deps.openSession(outcome.claim.sessionId, outcome.claim.where ?? 'tab');
  return 'claimed';
}
