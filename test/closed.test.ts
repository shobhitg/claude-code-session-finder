import { describe, it, expect } from 'vitest';
import { applyClosed, isClosed, CLOSE_GRACE_MS } from '../src/core/closed.js';
import type { Liveness } from '../src/core/state.js';

const S = 1_000, H = 3_600_000;
const T = 100 * H;                                  // the moment of the close
const WINDOW = 4 * H;
const live = (sessionId: string, lastWriteMs: number): [string, Liveness] =>
  [sessionId, { sessionId, verdict: 'turn-ended', state: { kind: 'attention', reason: 'your-turn' }, lastWriteMs }];

describe('isClosed', () => {
  it('holds while the session has not been written after the close, allowing the tab shutdown its own write', () => {
    expect(isClosed(T, T - 5 * S)).toBe(true);                 // last write before the close
    expect(isClosed(T, T + CLOSE_GRACE_MS)).toBe(true);        // the shutdown write, inside the grace
    expect(isClosed(T, T + CLOSE_GRACE_MS + 1)).toBe(false);   // resumed and written to: active again
    expect(isClosed(undefined, T - 5 * S)).toBe(false);        // no marker
  });
});

describe('applyClosed', () => {
  it('drops closed sessions from liveness and keeps the rest', () => {
    const raw = new Map([live('a', T - S), live('b', T - S)]);
    const r = applyClosed(raw, { a: T }, { now: T + 30 * S, activeWindowMs: WINDOW });
    expect([...r.liveness.keys()]).toEqual(['b']);
    expect(r.markers).toEqual({ a: T });
    expect(r.changed).toBe(false);
  });
  it('expires a marker once the session is written after the grace, and says the markers changed', () => {
    const raw = new Map([live('a', T + 60 * S)]);
    const r = applyClosed(raw, { a: T }, { now: T + 61 * S, activeWindowMs: WINDOW });
    expect([...r.liveness.keys()]).toEqual(['a']);
    expect(r.markers).toEqual({});
    expect(r.changed).toBe(true);
  });
  it('keeps a marker whose session is not in liveness yet (before the first sweep) until it is older than the window', () => {
    const fresh = applyClosed(new Map(), { a: T }, { now: T + 60 * S, activeWindowMs: WINDOW });
    expect(fresh.markers).toEqual({ a: T });
    expect(fresh.changed).toBe(false);
    const stale = applyClosed(new Map(), { a: T }, { now: T + WINDOW + CLOSE_GRACE_MS + 1, activeWindowMs: WINDOW });
    expect(stale.markers).toEqual({});
    expect(stale.changed).toBe(true);
  });
  it('a pinned session (its tab is open) loses its marker', () => {
    const r = applyClosed(new Map([live('a', T - S)]), { a: T }, { now: T + 5 * S, activeWindowMs: WINDOW, pinned: new Set(['a']) });
    expect([...r.liveness.keys()]).toEqual(['a']);
    expect(r.markers).toEqual({});
    expect(r.changed).toBe(true);
  });
  it('ignores malformed markers', () => {
    const r = applyClosed(new Map([live('a', T - S)]), { a: 'soon' as unknown as number, b: NaN }, { now: T, activeWindowMs: WINDOW });
    expect([...r.liveness.keys()]).toEqual(['a']);
    expect(r.markers).toEqual({});
    expect(r.changed).toBe(true);
  });
});
