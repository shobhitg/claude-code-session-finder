import { describe, it, expect } from 'vitest';
import { claimBaton } from '../src/baton.js';

const NOW = 1_000_000;
const raw = (o: object) => JSON.stringify(o);

describe('claimBaton', () => {
  it('claims a baton addressed to this folder', () => {
    const r = claimBaton(raw({ sessionId: 's', targetCwd: '/w/a', expiresAt: NOW + 1000 }), '/w/a', NOW);
    expect(r).toEqual({ claim: { sessionId: 's', targetCwd: '/w/a', expiresAt: NOW + 1000 } });
  });
  it('discards an expired baton', () => {
    expect(claimBaton(raw({ sessionId: 's', targetCwd: '/w/a', expiresAt: NOW - 1 }), '/w/a', NOW))
      .toEqual({ discard: true });
  });
  it('leaves a baton addressed to another folder', () => {
    expect(claimBaton(raw({ sessionId: 's', targetCwd: '/w/b', expiresAt: NOW + 1000 }), '/w/a', NOW))
      .toEqual({ leave: true });
  });
  it('discards unparseable or absent content', () => {
    expect(claimBaton('not json', '/w/a', NOW)).toEqual({ discard: true });
    expect(claimBaton(null, '/w/a', NOW)).toEqual({ discard: true });
  });
  it('leaves the baton when this window has no folder', () => {
    expect(claimBaton(raw({ sessionId: 's', targetCwd: '/w/a', expiresAt: NOW + 1000 }), undefined, NOW))
      .toEqual({ leave: true });
  });
  it('claims a baton whose folder differs only by trailing slash', () => {
    const r = claimBaton(raw({ sessionId: 's', targetCwd: '/w/a/', expiresAt: NOW + 1000 }), '/w/a', NOW);
    expect('claim' in r).toBe(true);
  });
});
