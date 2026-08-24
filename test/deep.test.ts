import { describe, it, expect } from 'vitest';
import { deepSearch } from '../src/core/deep.js';
import { parseQuery } from '../src/core/query.js';
import { INDEX_VERSION, type SearchIndex, type SessionMeta } from '../src/core/types.js';

const NOW = Date.parse('2026-08-24T00:00:00Z');
const meta = (id: string): SessionMeta => ({
  sessionId: id, file: `/${id}.jsonl`, extraFiles: [], projectDir: '-w-a', cwd: '/w/a', cwdExists: true,
  title: null, branches: [], prLinks: [], firstTs: NOW, lastTs: NOW, msgCount: 0, mtimeMs: 1, size: 1,
});

describe('deepSearch', () => {
  const index: SearchIndex = { v: INDEX_VERSION, builtAt: NOW, sessions: [meta('s1'), meta('s2')], prose: [] };
  const files: Record<string, string> = {
    '/s1.jsonl': JSON.stringify({ type: 'user', message: { content: [
      { type: 'tool_result', content: 'error TS2345 in query.ts' }] } }),
    '/s2.jsonl': JSON.stringify({ type: 'user', message: { content: [
      { type: 'tool_result', content: 'nothing relevant' }] } }),
  };
  const read = async (p: string) => files[p] ?? '';

  it('finds terms that appear only in tool content', async () => {
    const hits = await deepSearch(index, parseQuery('!TS2345', '7d', NOW), NOW, { readFileFn: read });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.session.sessionId).toBe('s1');
  });

  it('respects the recency window', async () => {
    const old = { ...index, sessions: [{ ...meta('s1'), lastTs: NOW - 40 * 86_400_000 }] };
    expect(await deepSearch(old, parseQuery('!TS2345', '7d', NOW), NOW, { readFileFn: read })).toHaveLength(0);
  });

  it('scans subagent transcripts and attributes the hit to the parent session (I4)', async () => {
    const parent = { ...meta('p1'), extraFiles: ['/p1-sub.jsonl'] };
    const idx: SearchIndex = { v: INDEX_VERSION, builtAt: NOW, sessions: [parent], prose: [] };
    const subFiles: Record<string, string> = {
      '/p1.jsonl': 'nothing here',
      '/p1-sub.jsonl': 'ran npm run build in the subagent',
    };
    const hits = await deepSearch(idx, parseQuery('!"npm run build"', '7d', NOW), NOW,
      { readFileFn: async p => subFiles[p] ?? '' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.session.sessionId).toBe('p1');
  });

  it('matches case-insensitively without lowercasing the whole file', async () => {
    const hits = await deepSearch(index, parseQuery('!ts2345', '7d', NOW), NOW, { readFileFn: read });
    expect(hits.map(h => h.session.sessionId)).toEqual(['s1']);
  });

  // C1: a renderToken guard stopped a stale scan RENDERING; nothing stopped it RUNNING.
  it('stops reading files once cancelled, instead of running to completion', async () => {
    const many = Array.from({ length: 80 }, (_, i) => meta(`s${i}`));
    const idx: SearchIndex = { v: INDEX_VERSION, builtAt: NOW, sessions: many, prose: [] };
    let reads = 0;
    let cancel = false;
    const counting = async () => { reads++; return 'irrelevant text'; };
    const hits = await deepSearch(idx, parseQuery('!TS2345', '7d', NOW), NOW,
      { readFileFn: counting, chunkSize: 8, cancelled: () => { if (reads >= 8) cancel = true; return cancel; } });
    expect(reads).toBeLessThanOrEqual(16);              // the first chunk, and no further chunk
    expect(reads).toBeLessThan(many.length);
    expect(hits).toHaveLength(0);
  });
});
