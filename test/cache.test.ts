import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { refreshIndex } from '../src/core/cache.js';
import { INDEX_VERSION } from '../src/core/types.js';

let root: string, cacheFile: string;
const sessionLine = (cwd: string, text: string) =>
  JSON.stringify({ type: 'user', cwd, timestamp: '2026-08-01T00:00:00Z', message: { content: text } });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ccsf-cache-'));
  cacheFile = join(root, 'index.json');
  mkdirSync(join(root, 'projects', '-w-a'), { recursive: true });
  writeFileSync(join(root, 'projects', '-w-a', 's1.jsonl'), sessionLine('/w/a', 'hello world') + '\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const opts = () => ({ root: join(root, 'projects'), cacheFile, existsSync: (p: string) => p === '/w/a' });

describe('refreshIndex', () => {
  it('builds an index on first run', async () => {
    const { index, stats } = await refreshIndex(opts());
    expect(index.v).toBe(INDEX_VERSION);
    expect(index.sessions).toHaveLength(1);
    expect(index.sessions[0]!.cwdExists).toBe(true);
    expect(index.prose.some(p => p.x === 'hello world')).toBe(true);
    expect(stats.reExtracted).toBe(1);
  });

  it('skips unchanged files on the second run', async () => {
    await refreshIndex(opts());
    const { stats } = await refreshIndex(opts());
    expect(stats.scanned).toBe(1);
    expect(stats.reExtracted).toBe(0);
  });

  it('re-extracts a file whose mtime changed', async () => {
    await refreshIndex(opts());
    const f = join(root, 'projects', '-w-a', 's1.jsonl');
    writeFileSync(f, sessionLine('/w/a', 'hello world') + '\n' + sessionLine('/w/a', 'second turn') + '\n');
    const future = new Date(Date.now() + 60_000);
    utimesSync(f, future, future);
    const { index, stats } = await refreshIndex(opts());
    expect(stats.reExtracted).toBe(1);
    expect(index.prose.some(p => p.x === 'second turn')).toBe(true);
  });

  it('discards a cache whose version does not match', async () => {
    writeFileSync(cacheFile, JSON.stringify({ v: 999, builtAt: 0, sessions: [], prose: [] }));
    const { index, stats } = await refreshIndex(opts());
    expect(index.v).toBe(INDEX_VERSION);
    expect(stats.reExtracted).toBe(1);
  });

  it('marks a session whose cwd no longer exists', async () => {
    mkdirSync(join(root, 'projects', '-w-b'), { recursive: true });
    writeFileSync(join(root, 'projects', '-w-b', 's2.jsonl'), sessionLine('/gone', 'x') + '\n');
    const { index } = await refreshIndex(opts());
    expect(index.sessions.find(s => s.sessionId === 's2')!.cwdExists).toBe(false);
  });

  it('prose from a subagent points at its parent session', async () => {
    mkdirSync(join(root, 'projects', '-w-a', 's1', 'subagents'), { recursive: true });
    writeFileSync(join(root, 'projects', '-w-a', 's1', 'subagents', 'agent-1.jsonl'),
      JSON.stringify({ type: 'assistant', timestamp: '2026-08-01T00:00:00Z',
                       message: { content: [{ type: 'text', text: 'agent finding' }] } }) + '\n');
    const { index } = await refreshIndex(opts());
    const hit = index.prose.find(p => p.x === 'agent finding')!;
    expect(hit.r).toBe('sub');
    expect(index.sessions[hit.s]!.sessionId).toBe('s1');
  });
});
