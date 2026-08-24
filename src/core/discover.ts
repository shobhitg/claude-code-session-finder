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
      // <sessionId>/subagents/*.jsonl — everything else in the sidecar dir is ignored
      const subDir = join(projectPath, entry, 'subagents');
      for (const agent of await safeReaddir(subDir)) {
        if (!agent.endsWith('.jsonl')) continue;
        const path = join(subDir, agent);
        const s = await stat(path).catch(() => null);
        if (!s?.isFile()) continue;
        out.push({ path, sessionId: entry, projectDir, kind: 'subagent',
                   mtimeMs: s.mtimeMs, size: s.size });
      }
    }
  }
  return out;
}
