import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'node:fs';
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

  it('does not persist a flat prose array on disk', async () => {
    await refreshIndex(opts());
    const onDisk = JSON.parse(readFileSync(cacheFile, 'utf8'));
    expect(onDisk.prose).toBeUndefined();
    expect(onDisk.sessions).toBeUndefined();
    expect(onDisk.files).toBeDefined();
  });

  it('derives an equivalent index from files on a warm run', async () => {
    const first = await refreshIndex(opts());
    const second = await refreshIndex(opts());
    expect(second.stats.reExtracted).toBe(0);
    expect(second.index.sessions).toEqual(first.index.sessions);
    expect(second.index.prose).toEqual(first.index.prose);
  });

  it('prose from a subagent points at its parent session, including on a warm refresh', async () => {
    mkdirSync(join(root, 'projects', '-w-a', 's1', 'subagents'), { recursive: true });
    writeFileSync(join(root, 'projects', '-w-a', 's1', 'subagents', 'agent-1.jsonl'),
      JSON.stringify({ type: 'assistant', timestamp: '2026-08-01T00:00:00Z',
                       message: { content: [{ type: 'text', text: 'agent finding' }] } }) + '\n');
    await refreshIndex(opts());                          // cold build, populates the cache
    const { index, stats } = await refreshIndex(opts());  // warm: must derive from `files`
    expect(stats.reExtracted).toBe(0);
    const hit = index.prose.find(p => p.x === 'agent finding')!;
    expect(hit.r).toBe('sub');
    expect(index.sessions[hit.s]!.sessionId).toBe('s1');
  });

  // C2: the same sessionId genuinely appears in two project dirs once a session moves
  // worktree. Which copy wins must not be decided by readdir order.
  it('resolves a duplicate sessionId to the copy with the later lastTs, keeping both files searchable', async () => {
    const line = (cwd: string, ts: string, text: string) =>
      JSON.stringify({ type: 'user', cwd, timestamp: ts, message: { content: text } });
    mkdirSync(join(root, 'projects', '-w-old'), { recursive: true });
    mkdirSync(join(root, 'projects', '-w-new'), { recursive: true });
    writeFileSync(join(root, 'projects', '-w-old', 'dup.jsonl'),
      line('/w/old', '2026-08-01T00:00:00Z', 'older half of the conversation') + '\n');
    writeFileSync(join(root, 'projects', '-w-new', 'dup.jsonl'),
      line('/w/new', '2026-08-05T00:00:00Z', 'newer half of the conversation') + '\n');

    const { index } = await refreshIndex(opts());
    const dup = index.sessions.filter(s => s.sessionId === 'dup');
    expect(dup).toHaveLength(1);                                  // one row, not two
    expect(dup[0]!.cwd).toBe('/w/new');                           // the LATER copy's cwd wins
    expect(dup[0]!.lastTs).toBe(Date.parse('2026-08-05T00:00:00Z'));
    expect(dup[0]!.firstTs).toBe(Date.parse('2026-08-01T00:00:00Z'));
    expect(dup[0]!.msgCount).toBe(2);                             // both files counted
    expect(dup[0]!.extraFiles).toContain(join(root, 'projects', '-w-old', 'dup.jsonl'));

    // BOTH files' prose survives, attributed to the surviving session.
    const at = index.sessions.indexOf(dup[0]!);
    const texts = index.prose.filter(p => p.s === at).map(p => p.x);
    expect(texts).toContain('older half of the conversation');
    expect(texts).toContain('newer half of the conversation');
  });

  it('picks the same duplicate winner regardless of which copy is seen first', async () => {
    const line = (cwd: string, ts: string) =>
      JSON.stringify({ type: 'user', cwd, timestamp: ts, message: { content: 'x' } });
    mkdirSync(join(root, 'projects', 'aaa'), { recursive: true });
    mkdirSync(join(root, 'projects', 'zzz'), { recursive: true });
    // 'aaa' sorts FIRST but is the later session: a readdir-ordered last-write-wins
    // would pick 'zzz', so this is differential, not merely stable.
    writeFileSync(join(root, 'projects', 'aaa', 'dup.jsonl'), line('/w/aaa', '2026-08-09T00:00:00Z') + '\n');
    writeFileSync(join(root, 'projects', 'zzz', 'dup.jsonl'), line('/w/zzz', '2026-08-01T00:00:00Z') + '\n');
    const first = await refreshIndex(opts());
    const second = await refreshIndex(opts());                    // warm: derived from `files`
    expect(first.index.sessions.find(s => s.sessionId === 'dup')!.cwd).toBe('/w/aaa');
    expect(second.index.sessions).toEqual(first.index.sessions);
  });
});
