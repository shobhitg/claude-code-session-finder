import { describe, it, expect } from 'vitest';
import { deepSearch } from '../src/core/deep.js';
import { parseQuery } from '../src/core/query.js';
import { INDEX_VERSION, type SearchIndex, type SessionMeta } from '../src/core/types.js';

const NOW = Date.parse('2026-08-24T00:00:00Z');
const meta = (id: string): SessionMeta => ({
  sessionId: id, file: `/${id}.jsonl`, projectDir: '-w-a', cwd: '/w/a', cwdExists: true,
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
    const hits = await deepSearch(index, parseQuery('!TS2345', '7d', NOW), NOW, read);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.session.sessionId).toBe('s1');
  });

  it('respects the recency window', async () => {
    const old = { ...index, sessions: [{ ...meta('s1'), lastTs: NOW - 40 * 86_400_000 }] };
    expect(await deepSearch(old, parseQuery('!TS2345', '7d', NOW), NOW, read)).toHaveLength(0);
  });
});
