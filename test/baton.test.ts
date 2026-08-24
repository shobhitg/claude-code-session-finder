import { describe, it, expect } from 'vitest';
import { claimBaton, claimPendingOpen } from '../src/baton.js';

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

// I2: a window that is ALREADY OPEN on the target folder never re-runs activate(), so the
// claim has to work when it is triggered later (by the baton file appearing) rather than
// once at startup. claimPendingOpen is that trigger-agnostic sequence.
describe('claimPendingOpen (already-running window)', () => {
  const setup = (initial: string | null) => {
    let baton = initial;
    const opened: string[] = [];
    const order: string[] = [];
    return {
      opened, order,
      write: (o: object) => { baton = raw(o); },
      deps: {
        read: async () => baton,
        remove: async () => { baton = null; order.push('remove'); },
        openSession: async (id: string) => { opened.push(id); order.push('open'); },
        myFolder: '/w/a',
        now: NOW,
      },
    };
  };

  it('claims a baton that appears AFTER the first (startup) attempt found nothing', async () => {
    const s = setup(null);
    expect(await claimPendingOpen(s.deps)).toBe('discarded');   // startup: no baton yet
    expect(s.opened).toEqual([]);

    s.write({ sessionId: 'sid', targetCwd: '/w/a', expiresAt: NOW + 1000 });
    expect(await claimPendingOpen(s.deps)).toBe('claimed');     // watcher fires later
    expect(s.opened).toEqual(['sid']);
    expect(s.order.slice(-2)).toEqual(['remove', 'open']);      // delete-before-open preserved
  });

  it('is single-use: a second trigger for the same baton opens nothing', async () => {
    const s = setup(raw({ sessionId: 'sid', targetCwd: '/w/a', expiresAt: NOW + 1000 }));
    expect(await claimPendingOpen(s.deps)).toBe('claimed');
    expect(await claimPendingOpen(s.deps)).toBe('discarded');
    expect(s.opened).toEqual(['sid']);
  });

  it('leaves a baton addressed elsewhere on disk for the window that owns it', async () => {
    const s = setup(raw({ sessionId: 'sid', targetCwd: '/w/other', expiresAt: NOW + 1000 }));
    expect(await claimPendingOpen(s.deps)).toBe('left');
    expect(s.order).toEqual([]);                                // not removed, not opened
  });

  it('matches the folder with samePath, not ===', async () => {
    const s = setup(raw({ sessionId: 'sid', targetCwd: '/w/a/', expiresAt: NOW + 1000 }));
    expect(await claimPendingOpen(s.deps)).toBe('claimed');
  });

  it('discards an expired baton without opening anything', async () => {
    const s = setup(raw({ sessionId: 'sid', targetCwd: '/w/a', expiresAt: NOW - 1 }));
    expect(await claimPendingOpen(s.deps)).toBe('discarded');
    expect(s.opened).toEqual([]);
    expect(s.order).toEqual(['remove']);   // a dead baton is cleaned up, never opened
  });
});
