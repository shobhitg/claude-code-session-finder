import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync as nodeExistsSync } from 'node:fs';
import { dirname } from 'node:path';
import { INDEX_VERSION, type SearchIndex, type SessionMeta, type ProseMsg } from './types.js';
import { discover, defaultRoot, type SourceFile } from './discover.js';
import { extractSession, extractSubagent, type BareProse } from './extract.js';

export interface RefreshStats { scanned: number; reExtracted: number; ms: number }

interface CachedFile { key: string; meta?: SessionMeta; prose: BareProse[] }
interface CacheShape extends SearchIndex { files?: Record<string, CachedFile> }

const keyOf = (f: SourceFile) => `${f.mtimeMs}:${f.size}`;

async function loadCache(cacheFile: string): Promise<Record<string, CachedFile>> {
  try {
    const parsed = JSON.parse(await readFile(cacheFile, 'utf8')) as CacheShape;
    if (parsed.v !== INDEX_VERSION || !parsed.files) return {};
    return parsed.files;
  } catch { return {}; }
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
                 return { key, meta: { ...meta, cwdExists: !!meta.cwd && exists(meta.cwd) }, prose }; })()
      : { key, prose: extractSubagent(f, text) };
  }

  // Assemble: sessions first so subagent prose can point at a parent index.
  const sessions: SessionMeta[] = [];
  const bySessionId = new Map<string, number>();
  for (const entry of Object.values(next)) {
    if (!entry.meta) continue;
    bySessionId.set(entry.meta.sessionId, sessions.length);
    sessions.push(entry.meta);
  }
  const prose: ProseMsg[] = [];
  for (const [path, entry] of Object.entries(next)) {
    const sessionId = entry.meta?.sessionId ?? files.find(f => f.path === path)?.sessionId;
    const s = sessionId !== undefined ? bySessionId.get(sessionId) : undefined;
    if (s === undefined) continue;                 // orphan subagent — parent file is gone
    for (const p of entry.prose) prose.push({ ...p, s });
  }

  const index: SearchIndex = { v: INDEX_VERSION, builtAt: Date.now(), sessions, prose };
  await mkdir(dirname(opts.cacheFile), { recursive: true }).catch(() => {});
  await writeFile(opts.cacheFile, JSON.stringify({ ...index, files: next })).catch(() => {});
  return { index, stats: { scanned: files.length, reExtracted, ms: Date.now() - started } };
}
