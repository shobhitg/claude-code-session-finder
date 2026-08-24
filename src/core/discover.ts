import { readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

export interface SourceFile {
  path: string;
  /** For subagents this is the PARENT session id, so matches attribute correctly. */
  sessionId: string;
  projectDir: string;
  kind: 'session' | 'subagent';
  mtimeMs: number;
  size: number;
}

export function defaultRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

async function safeReaddir(dir: string): Promise<string[]> {
  try { return await readdir(dir); } catch { return []; }
}

async function discoverSubagentsRecursive(
  subagentsRoot: string,
  sessionId: string,
  projectDir: string,
  depth: number = 0,
  out: SourceFile[] = [],
): Promise<SourceFile[]> {
  // Cap depth at 6 to avoid symlink loops
  if (depth > 6) return out;

  for (const entry of await safeReaddir(subagentsRoot)) {
    const path = join(subagentsRoot, entry);
    const s = await stat(path).catch(() => null);
    if (!s) continue;

    if (s.isFile() && entry.endsWith('.jsonl')) {
      out.push({
        path,
        sessionId,
        projectDir,
        kind: 'subagent',
        mtimeMs: s.mtimeMs,
        size: s.size,
      });
    } else if (s.isDirectory()) {
      // Recursively descend into subdirectories
      await discoverSubagentsRecursive(path, sessionId, projectDir, depth + 1, out);
    }
  }

  return out;
}

export async function discover(root: string = defaultRoot()): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  for (const projectDir of await safeReaddir(root)) {
    const projectPath = join(root, projectDir);
    for (const entry of await safeReaddir(projectPath)) {
      if (entry.endsWith('.jsonl')) {
        const path = join(projectPath, entry);
        const s = await stat(path).catch(() => null);
        if (!s?.isFile()) continue;
        out.push({ path, sessionId: basename(entry, '.jsonl'), projectDir,
                   kind: 'session', mtimeMs: s.mtimeMs, size: s.size });
        continue;
      }
      // <sessionId>/subagents/ — recursively discover .jsonl files at any depth
      const subDir = join(projectPath, entry, 'subagents');
      await discoverSubagentsRecursive(subDir, entry, projectDir, 0, out);
    }
  }
  return out;
}
