import type { SessionMeta } from './types.js';
import { samePath, isInside } from './paths.js';

export type OpenPlan =
  | { kind: 'here'; sessionId: string; note?: string }
  | { kind: 'handoff'; sessionId: string; targetCwd: string }
  | { kind: 'transcript'; file: string; reason: string };

export function planOpen(session: SessionMeta, workspaceFolders: string[]): OpenPlan {
  const { sessionId, cwd, cwdExists, file } = session;

  if (cwd && !cwdExists) return { kind: 'transcript', file, reason: 'folder missing' };
  if (!cwd) return { kind: 'here', sessionId, note: 'unknown folder — resuming in this window' };

  const primary = workspaceFolders[0];
  if (primary && samePath(cwd, primary)) return { kind: 'here', sessionId };

  // F5: every workspace folder is passed as additionalDirectories, so a session
  // under any of them is safe to resume here; only the cwd differs.
  if (workspaceFolders.some(f => isInside(cwd, f))) {
    return { kind: 'here', sessionId, note: 'resuming at the workspace root, not the session folder' };
  }
  return { kind: 'handoff', sessionId, targetCwd: cwd };
}
