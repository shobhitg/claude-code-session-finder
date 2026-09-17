import { isInside, samePath } from './paths.js';

/** Claude Code's project-directory name for a path: every non-alphanumeric becomes `-`. */
export const projectDirName = (p: string): string => p.replace(/[^A-Za-z0-9]/g, '-');

/**
 * Does a session belong to a workspace described by `roots` (its folders, their main checkouts
 * and every worktree of those repos)? The last recorded cwd decides when there is one — it is
 * authoritative even when the project-directory name disagrees (F6). Only a session with no cwd
 * falls back to that name. No roots means no workspace is open: everything is in scope.
 */
export function inScope(m: { cwd: string | null; projectDir: string }, roots: readonly string[]): boolean {
  if (roots.length === 0) return true;
  for (const r of roots) {
    if (m.cwd) { if (samePath(m.cwd, r) || isInside(m.cwd, r)) return true; continue; }
    const name = projectDirName(r);
    if (m.projectDir === name || m.projectDir.startsWith(`${name}-`)) return true;
  }
  return false;
}
