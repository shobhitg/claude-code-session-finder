import { describe, it, expect } from 'vitest';
import { parseQuery, search, snippet, withWindow } from '../src/core/query.js';
import { INDEX_VERSION, type SearchIndex, type SessionMeta } from '../src/core/types.js';

const NOW = Date.parse('2026-08-24T00:00:00Z');
const DAY = 86_400_000;

const meta = (id: string, over: Partial<SessionMeta> = {}): SessionMeta => ({
  sessionId: id, file: `/${id}.jsonl`, extraFiles: [], projectDir: '-w-a', cwd: '/w/a', cwdExists: true,
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
  // M6: the strip regexes are global, like withWindow's. Non-global left the second
  // clause behind as a literal search term that matched nothing.
  it('strips EVERY pr:/since: clause, not just the first', () => {
    const q = parseQuery('foo pr:1 pr:2', '7d', NOW);
    expect(q.terms).toEqual(['foo']);
    expect(q.pr).toBe(2);
    const w = parseQuery('foo since:14d since:all', '7d', NOW);
    expect(w.terms).toEqual(['foo']);
    expect(w.sinceMs).toBeNull();
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
  it('treats an unterminated quote as a phrase still being typed', () => {
    expect(parseQuery('"paste image', '7d', NOW).phrase).toBe('paste image');
  });
  it('treats empty quotes as no phrase and leaves no stray quote in terms', () => {
    const q = parseQuery('""', '7d', NOW);
    expect(q.phrase).toBeNull();
    expect(q.terms).not.toContain('"');
  });
  it('treats a lone quote as no phrase and leaves no stray quote in terms', () => {
    const q = parseQuery('"', '7d', NOW);
    expect(q.terms).not.toContain('"');
  });
  it('falls back to the default window on a malformed since: value', () => {
    expect(parseQuery('x since:xyz', '7d', NOW).sinceMs).toBe(NOW - 7 * DAY);
  });
  it('only the first quoted region becomes the phrase; a second quoted group leaves no stray quote', () => {
    const q = parseQuery('"foo" "bar"', '7d', NOW);
    expect(q.phrase).toBe('foo');
    expect(q.terms).toEqual(['bar']);
  });
  it('strips every remaining quote when more than two appear', () => {
    expect(parseQuery('""""', '7d', NOW).terms).not.toContain('"');
  });
  it('never lets a bare quote reach terms, and phrase is null or non-empty, across awkward inputs', () => {
    const inputs = [
      '"', '""', '""""', 'a"b', '"foo" "bar"', '"foo" bar" baz', '!"a" "b"', 'pr:1 "x" "y"',
    ];
    for (const input of inputs) {
      const q = parseQuery(input, '7d', NOW);
      for (const term of q.terms) expect(term).not.toContain('"');
      expect(q.phrase === null || q.phrase.length > 0).toBe(true);
    }
  });
});

describe('withWindow', () => {
  it('replaces an existing since: clause', () => {
    expect(withWindow('foo since:14d', 'all')).toBe('foo since:all');
  });
  it('is idempotent', () => {
    expect(withWindow('foo since:all', 'all')).toBe('foo since:all');
  });
  it('collapses multiple since: clauses to exactly one', () => {
    const result = withWindow('foo since:14d since:30d', 'all');
    expect(result.match(/since:/g)).toHaveLength(1);
    expect(result).toBe('foo since:all');
  });
  it('leaves no leading/trailing whitespace artefacts when there is nothing else', () => {
    expect(withWindow('since:14d', 'all')).toBe('since:all');
  });
  it('is case-insensitive', () => {
    expect(withWindow('foo SINCE:14d', 'all')).toBe('foo since:all');
  });

  // I1: an unterminated quote is the state for the ENTIRE duration of typing a phrase, so
  // this is the common case, not an edge case. Appending after the region put the clause
  // INSIDE the phrase; the clause goes in front of the region instead.
  it('never appends the clause inside an unterminated phrase', () => {
    expect(withWindow('"paste image', 'all')).toBe('since:all "paste image');
  });
  it('is idempotent for an unterminated phrase', () => {
    const once = withWindow('"paste image', 'all');
    expect(withWindow(once, 'all')).toBe(once);
    expect(withWindow(withWindow(once, 'all'), 'all').match(/since:/g)).toHaveLength(1);
  });
  it('keeps terms before an unterminated phrase, and replaces their since: clause', () => {
    expect(withWindow('foo since:14d "paste image', 'all')).toBe('foo since:all "paste image');
  });
  it('regression guard: a quoted phrase containing "since:" is left byte-identical', () => {
    const input = '"deploy since:v2 notes"';
    expect(withWindow(input, 'all')).toBe(`${input} since:all`);
  });
  it('strips an outside since: clause while preserving one inside quotes', () => {
    expect(withWindow('"a since:1d" since:14d', 'all')).toBe('"a since:1d" since:all');
  });

  const NOW2 = Date.parse('2026-08-24T00:00:00Z');
  const cases: Array<[string, string | null]> = [
    ['foo since:14d', null],
    ['foo since:all', null],
    ['foo since:14d since:30d', null],
    ['since:14d', null],
    ['foo SINCE:14d', null],
    ['"deploy since:v2 notes"', 'deploy since:v2 notes'],
    ['"a since:1d" since:14d', 'a since:1d'],
    ['"paste image', 'paste image'],
    ['since:all "paste image', 'paste image'],
    ['foo since:14d "paste image', 'paste image'],
  ];
  it.each(cases)('round-trips through parseQuery: %s', (input, expectedPhrase) => {
    const result = withWindow(input, 'all');
    const q = parseQuery(result, '7d', NOW2);
    expect(q.sinceMs).toBeNull();
    expect(q.phrase).toBe(expectedPhrase);
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

  it('finds a match via an unterminated-quote query typed mid-phrase', () => {
    const hits = search(index, parseQuery('"paste image', '7d', NOW), NOW);
    expect(hits.map(h => h.session.sessionId)).toContain('s1');
  });

  // Chosen semantics for a second quoted group: only the first quoted region becomes
  // `phrase`; any further quoted text is stripped to plain (space-separated) terms.
  // matchQuality() checks `phrase` first and ignores `terms` whenever a phrase is set,
  // so a second quoted group does not add an extra match constraint -- the query still
  // matches on the first phrase alone, rather than silently returning zero results.
  it('a second quoted group does not suppress a real match on the first phrase', () => {
    const hits = search(index, parseQuery('"paste image" "npm run"', '7d', NOW), NOW);
    expect(hits.map(h => h.session.sessionId)).toContain('s1');
  });
});

describe('snippet', () => {
  it('windows around the match and ellipsises', () => {
    const s = snippet('x'.repeat(100) + 'NEEDLE' + 'y'.repeat(100), 100, 10);
    expect(s).toContain('NEEDLE');
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
  });

  it('clamps an out-of-range negative index instead of returning most of the string', () => {
    const s = snippet('y'.repeat(10000), -100, 10);
    expect(s.length).toBeLessThanOrEqual(25);
  });
});
