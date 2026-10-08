import type { SessionMeta } from './types.js';
import type { OpenWhere } from './open-args.js';
import { samePath, isInside } from './paths.js';

/**
 * D15: a plain open (a row click, Enter, the picker) of a headless session reads it in the Session View —
 * Claude Code's own tab comes up blank for one. Asking for the right panel is still asking to resume it.
 */
export function readsInView(session: Pick<SessionMeta, 'headless'>, where: OpenWhere): boolean {
  return session.headless && where === 'tab';
}

export type OpenPlan =
  | { kind: 'here'; sessionId: string; file: string; note?: string }
  | { kind: 'handoff'; sessionId: string; targetCwd: string }
  | { kind: 'transcript'; file: string; reason: string };

export function planOpen(session: SessionMeta, workspaceFolders: string[]): OpenPlan {
  const { sessionId, cwd, cwdExists, file } = session;

  if (cwd && !cwdExists) return { kind: 'transcript', file, reason: 'folder missing' };
  if (!cwd) return { kind: 'here', sessionId, file, note: 'unknown folder — resuming in this window' };

  const primary = workspaceFolders[0];
  if (primary && samePath(cwd, primary)) return { kind: 'here', sessionId, file };

  // F5: every workspace folder is passed as additionalDirectories, so a session
  // under any of them is safe to resume here; only the cwd differs.
  if (workspaceFolders.some(f => isInside(cwd, f))) {
    return { kind: 'here', sessionId, file, note: 'resuming at the workspace root, not the session folder' };
  }
  return { kind: 'handoff', sessionId, targetCwd: cwd };
}
