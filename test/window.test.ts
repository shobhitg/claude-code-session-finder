import { describe, it, expect } from 'vitest';
import { durationMs, parseQuery } from '../src/core/query.js';

const H = 3_600_000, D = 24 * H;

describe('durationMs', () => {
  it('parses hours, days, weeks and months', () => {
    expect(durationMs('4h', 1)).toBe(4 * H);
    expect(durationMs('2d', 1)).toBe(2 * D);
    expect(durationMs('1w', 1)).toBe(7 * D);
    expect(durationMs('1m', 1)).toBe(30 * D);
    expect(durationMs('3', 1)).toBe(3 * D);            // bare number = days, as since: always has
  });
  it('falls back for "all", blanks and garbage', () => {
    expect(durationMs('all', 7)).toBe(7);
    expect(durationMs('', 7)).toBe(7);
    expect(durationMs('  4 hours ', 7)).toBe(7);
  });
});

describe('since: accepts hours', () => {
  it('since:2h narrows to two hours ago', () => {
    const now = 10 * D;
    expect(parseQuery('paste since:2h', '60d', now).sinceMs).toBe(now - 2 * H);
  });
});
