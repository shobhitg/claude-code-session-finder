import { describe, it, expect } from 'vitest';
import { mdEscape } from '../src/surfaces/statusbar-escape.js';

describe('mdEscape', () => {
  it('neutralises markdown syntax in session titles without touching plain text', () => {
    expect(mdEscape('plain title')).toBe('plain title');
    expect(mdEscape('fix *bold* and [link](x) and `code` and #1 and a_b')).toBe(
      'fix \\*bold\\* and \\[link\\]\\(x\\) and \\`code\\` and \\#1 and a\\_b');
    expect(mdEscape('$(loading~spin) stays')).toBe('$\\(loading~spin\\) stays');   // no theme-icon injection from a title
  });
});
