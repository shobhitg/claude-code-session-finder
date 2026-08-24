import { samePath } from './core/paths.js';

export interface Baton { sessionId: string; targetCwd: string; expiresAt: number }

export function claimBaton(raw: string | null, myFolder: string | undefined, now: number):
  { claim: Baton } | { discard: true } | { leave: true } {
  if (!raw) return { discard: true };
  let b: Baton;
  try { b = JSON.parse(raw) as Baton; } catch { return { discard: true }; }
  if (typeof b?.sessionId !== 'string' || typeof b?.targetCwd !== 'string') return { discard: true };
  if (!(b.expiresAt > now)) return { discard: true };
  if (!myFolder) return { leave: true };
  // MUST use samePath, not ===. On macOS the planner may hand off to a differently
  // cased or NFD spelling of the same folder; a strict compare would silently no-op.
  return samePath(b.targetCwd, myFolder) ? { claim: b } : { leave: true };
}
