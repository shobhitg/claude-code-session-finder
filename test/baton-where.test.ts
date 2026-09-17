import { describe, it, expect } from 'vitest';
import { claimBaton, claimPendingOpen } from '../src/baton.js';

const raw = (o: object) => JSON.stringify({ sessionId: 's', targetCwd: '/w', expiresAt: 2_000, ...o });

describe('baton.where (spec §6, §11)', () => {
  it('keeps a valid where, drops an invalid one, tolerates its absence', () => {
    expect(claimBaton(raw({ where: 'right' }), '/w', 1_000))
      .toEqual({ claim: { sessionId: 's', targetCwd: '/w', expiresAt: 2_000, where: 'right' } });
    expect(claimBaton(raw({ where: 'sideways' }), '/w', 1_000))
      .toEqual({ claim: { sessionId: 's', targetCwd: '/w', expiresAt: 2_000 } });
    expect(claimBaton(raw({}), '/w', 1_000))
      .toEqual({ claim: { sessionId: 's', targetCwd: '/w', expiresAt: 2_000 } });
  });
  it('claimPendingOpen passes where to openSession, defaulting to tab', async () => {
    const calls: unknown[][] = [];
    const deps = (where?: string) => ({
      read: async () => raw(where ? { where } : {}), remove: async () => {}, myFolder: '/w', now: 1_000,
      openSession: async (id: string, w: string) => { calls.push([id, w]); },
    });
    expect(await claimPendingOpen(deps('right'))).toBe('claimed');
    expect(await claimPendingOpen(deps())).toBe('claimed');
    expect(calls).toEqual([['s', 'right'], ['s', 'tab']]);
  });
});
