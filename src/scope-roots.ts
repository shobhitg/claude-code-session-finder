import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, resolve } from 'node:path';
import { normalizePath } from './core/paths.js';

const run = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string | null> {
  try { return (await run('git', ['-C', cwd, ...args], { timeout: 3_000 })).stdout; } catch { return null; }
}

/**
 * The paths a workspace "is": each folder, the main checkout of its repo (a folder may itself be a
 * worktree), and every worktree of that repo — so a session started in `.worktrees/feature` or in
 * a worktree parked elsewhere still counts as this project's. Folders that are not git repos
 * contribute themselves only. Never throws; a missing git just yields the folders.
 */
export async function workspaceRoots(folders: readonly string[]): Promise<string[]> {
  const roots = new Set<string>();
  for (const f of folders) {
    roots.add(normalizePath(f));
    const common = (await git(f, ['rev-parse', '--git-common-dir']))?.trim();
    if (common) {
      const abs = resolve(f, common);
      if (basename(abs) === '.git') roots.add(normalizePath(dirname(abs)));
    }
    for (const line of (await git(f, ['worktree', 'list', '--porcelain']))?.split('\n') ?? []) {
      if (line.startsWith('worktree ')) roots.add(normalizePath(line.slice('worktree '.length).trim()));
    }
  }
  return [...roots];
}
