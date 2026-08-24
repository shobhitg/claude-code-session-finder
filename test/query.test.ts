import { describe, it, expect } from 'vitest';
import { parseQuery, search, snippet } from '../src/core/query.js';
import { INDEX_VERSION, type SearchIndex, type SessionMeta } from '../src/core/types.js';

const NOW = Date.parse('2026-08-24T00:00:00Z');
const DAY = 86_400_000;

const meta = (id: string, over: Partial<SessionMeta> = {}): SessionMeta => ({
  sessionId: id, file: `/${id}.jsonl`, projectDir: '-w-a', cwd: '/w/a', cwdExists: true,
  title: null, branches: [], prLinks: [], firstTs: NOW - DAY, lastTs: NOW - DAY,
  msgCount: 1, mtimeMs: 1, size: 1, ...over,
});

describe('parseQuery', () => {
  it('splits bare terms and lowercases them', () => {
    const q = parseQuery('Paste Image', '7d', NOW);
    expect(q.terms).toEqual(['paste', 'image']);
    expect(q.phrase).toBeNull();
    expect(q.sinceMs).toBe(NOW - 7 * DAY);
  });
  it('extracts a quoted phrase', () => {
    expect(parseQuery('"paste image"', '7d', NOW).phrase).toBe('paste image');
  });
  it('extracts pr: and removes it from the terms', () => {
    const q = parseQuery('pr:18942', '7d', NOW);
    expect(q.pr).toBe(18942);
    expect(q.terms).toEqual([]);
  });
  it('honours since: overrides including all', () => {
    expect(parseQuery('x since:30d', '7d', NOW).sinceMs).toBe(NOW - 30 * DAY);
    expect(parseQuery('x since:all', '7d', NOW).sinceMs).toBeNull();
    expect(parseQuery('x', 'all', NOW).sinceMs).toBeNull();
  });
  it('detects the ! deep-search prefix', () => {
    const q = parseQuery('!npm run build', '7d', NOW);
    expect(q.deep).toBe(true);
    expect(q.terms).toEqual(['npm', 'run', 'build']);
  });
});

describe('search', () => {
  const index: SearchIndex = {
    v: INDEX_VERSION, builtAt: NOW,
    sessions: [meta('s1'), meta('s2'), meta('s3', { prLinks: [18942] }),
               meta('s4', { title: 'Paste image handling' })],
    prose: [
      { s: 0, r: 'u', t: NOW - DAY, x: 'the paste image bug is annoying' },
      { s: 1, r: 'a', t: NOW - DAY, x: 'you can paste an image into the composer' },
      { s: 2, r: 'a', t: NOW - DAY, x: 'unrelated prose' },
      { s: 3, r: 't', t: NOW - DAY, x: 'Paste image handling' },
    ],
  };

  it('ranks your prompts above Claude prose for the same match', () => {
    const hits = search(index, parseQuery('paste image', '7d', NOW), NOW);
    const ids = hits.map(h => h.session.sessionId);
    expect(ids.indexOf('s1')).toBeLessThan(ids.indexOf('s2'));
  });

  it('ranks a title match at the top', () => {
    const hits = search(index, parseQuery('paste image', '7d', NOW), NOW);
    expect(hits[0]!.session.sessionId).toBe('s4');
  });

  it('pr: short-circuits to the owning session', () => {
    const hits = search(index, parseQuery('pr:18942', '7d', NOW), NOW);
    expect(hits[0]!.session.sessionId).toBe('s3');
  });

  it('an exact phrase outranks scattered terms', () => {
    const phrase = search(index, parseQuery('"paste image"', '7d', NOW), NOW);
    expect(phrase.map(h => h.session.sessionId)).toContain('s1');
    expect(phrase.map(h => h.session.sessionId)).not.toContain('s2'); // "paste an image"
  });

  it('excludes sessions outside the recency window', () => {
    const old: SearchIndex = { ...index,
      sessions: [meta('old', { lastTs: NOW - 40 * DAY })],
      prose: [{ s: 0, r: 'u', t: NOW - 40 * DAY, x: 'paste image' }] };
    expect(search(old, parseQuery('paste image', '7d', NOW), NOW)).toHaveLength(0);
    expect(search(old, parseQuery('paste image since:all', '7d', NOW), NOW)).toHaveLength(1);
  });

  it('returns one hit per session with a match count', () => {
    const many: SearchIndex = { ...index, sessions: [meta('s1')],
      prose: [{ s: 0, r: 'u', t: NOW, x: 'paste image' }, { s: 0, r: 'a', t: NOW, x: 'paste image again' }] };
    const hits = search(many, parseQuery('paste image', '7d', NOW), NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.matchCount).toBe(2);
  });
});

describe('snippet', () => {
  it('windows around the match and ellipsises', () => {
    const s = snippet('x'.repeat(100) + 'NEEDLE' + 'y'.repeat(100), 100, 10);
    expect(s).toContain('NEEDLE');
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
  });
});
