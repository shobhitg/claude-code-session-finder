import { describe, it, expect } from 'vitest';
import { normalizePath, samePath, isInside } from '../src/core/paths.js';

describe('paths on linux (case-sensitive, NFC)', () => {
  const L: NodeJS.Platform = 'linux';
  it('is case-sensitive', () => {
    expect(samePath('/w/Foo', '/w/foo', L)).toBe(false);
  });
  it('ignores a trailing slash', () => {
    expect(samePath('/w/a/', '/w/a', L)).toBe(true);
  });
  it('does not treat a sibling prefix as inside', () => {
    expect(isInside('/w/ab', '/w/a', L)).toBe(false);
    expect(isInside('/w/a/b', '/w/a', L)).toBe(true);
    expect(isInside('/w/a', '/w/a', L)).toBe(true);
  });
});

describe('paths on darwin (case-insensitive, NFD source)', () => {
  const D: NodeJS.Platform = 'darwin';
  it('folds case, because the default APFS volume does', () => {
    expect(samePath('/Users/Shobhit/src', '/users/shobhit/src', D)).toBe(true);
  });
  it('normalizes NFD to NFC, matching Claude Code itself', () => {
    const nfd = '/w/café';        // e + combining acute — what macOS may hand back
    const nfc = '/w/café';          // precomposed e-acute
    expect(nfd).not.toBe(nfc);
    expect(samePath(nfd, nfc, D)).toBe(true);
    expect(normalizePath(nfd, D)).toBe(normalizePath(nfc, D));
  });
  it('still respects segment boundaries', () => {
    expect(isInside('/W/AB', '/w/a', D)).toBe(false);
    expect(isInside('/W/A/B', '/w/a', D)).toBe(true);
  });
});
