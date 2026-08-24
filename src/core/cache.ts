import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync as nodeExistsSync } from 'node:fs';
import { dirname } from 'node:path';
import { INDEX_VERSION, type SearchIndex, type SessionMeta, type ProseMsg } from './types.js';
import { discover, defaultRoot, type SourceFile } from './discover.js';
import { extractSession, extractSubagent, type BareProse } from './extract.js';

export interface RefreshStats { scanned: number; reExtracted: number; ms: number }

interface CachedFile { key: string; sessionId: string; meta?: SessionMeta; prose: BareProse[] }
interface PersistedCache { v: number; builtAt: number; files?: Record<string, CachedFile> }

const keyOf = (f: SourceFile) => `${f.mtimeMs}:${f.size}`;

async function loadCache(cacheFile: string): Promise<Record<string, CachedFile>> {
  try {
    const parsed = JSON.parse(await readFile(cacheFile, 'utf8')) as PersistedCache;
    if (parsed.v !== INDEX_VERSION || !parsed.files) return {};
    return parsed.files;
  } catch { return {}; }
}

/**
 * Sessions first so subagent prose can resolve its parent's index. This is the ONLY place
 * `sessions`/`prose` are produced — never persisted, always recomputed from `files` so the
 * on-disk cache doesn't duplicate prose text.
 */
function assemble(files: Record<string, CachedFile>): { sessions: SessionMeta[]; prose: ProseMsg[] } {
  const sessions: SessionMeta[] = [];
  const bySessionId = new Map<string, number>();
  for (const entry of Object.values(files)) {
    if (!entry.meta) continue;
    bySessionId.set(entry.meta.sessionId, sessions.length);
    sessions.push(entry.meta);
  }
  const prose: ProseMsg[] = [];
  for (const entry of Object.values(files)) {
    const s = bySessionId.get(entry.sessionId);
    if (s === undefined) continue;                 // orphan subagent — parent file is gone
    for (const p of entry.prose) prose.push({ ...p, s });
  }
  return { sessions, prose };
}

export async function refreshIndex(opts: {
  root?: string; cacheFile: string; existsSync?: (p: string) => boolean;
}): Promise<{ index: SearchIndex; stats: RefreshStats }> {
  const started = Date.now();
  const exists = opts.existsSync ?? nodeExistsSync;
  const files = await discover(opts.root ?? defaultRoot());
  const cached = await loadCache(opts.cacheFile);
  const next: Record<string, CachedFile> = {};
  let reExtracted = 0;

  for (const f of files) {
    const key = keyOf(f);
    const hit = cached[f.path];
    if (hit && hit.key === key) { next[f.path] = hit; continue; }
    reExtracted++;
    const text = await readFile(f.path, 'utf8').catch(() => '');
    next[f.path] = f.kind === 'session'
      ? (() => { const { meta, prose } = extractSession(f, text);
                 return { key, sessionId: f.sessionId,
                          meta: { ...meta, cwdExists: !!meta.cwd && exists(meta.cwd) }, prose }; })()
      : { key, sessionId: f.sessionId, prose: extractSubagent(f, text) };
  }

  const { sessions, prose } = assemble(next);
  const index: SearchIndex = { v: INDEX_VERSION, builtAt: Date.now(), sessions, prose };
  await mkdir(dirname(opts.cacheFile), { recursive: true }).catch(() => {});
  await writeFile(opts.cacheFile, JSON.stringify({ v: index.v, builtAt: index.builtAt, files: next })).catch(() => {});
  return { index, stats: { scanned: files.length, reExtracted, ms: Date.now() - started } };
}
