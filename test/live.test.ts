import { describe, it, expect, vi, afterEach } from 'vitest';
import { LivenessTracker, type TrackerDeps, type Change } from '../src/core/live.js';
import type { SourceFile } from '../src/core/discover.js';
import type { TailVerdict } from '../src/core/state.js';

const MIN = 60_000, H = 60 * MIN;

/** An in-memory corpus: the tracker only ever sees it through the injected deps. */
function harness(files: SourceFile[], verdicts: Record<string, TailVerdict>, start = 100 * H) {
  let clock = start;
  const reads: string[] = [];
  const deps: TrackerDeps = {
    discover: async () => files.map(f => ({ ...f })),
    stat: async p => {
      const f = files.find(x => x.path === p);
      if (!f) throw new Error('ENOENT');
      return { mtimeMs: f.mtimeMs, size: f.size };
    },
    readVerdict: async p => { reads.push(p); return verdicts[p] ?? 'unknown'; },
    now: () => clock,
  };
  const changes: Change[] = [];
  const tracker = new LivenessTracker({ activeWindowMs: 4 * H }, deps);
  tracker.onChange(c => changes.push(c));
  return { tracker, reads, changes, advance: (ms: number) => { clock += ms; }, now: () => clock, files };
}

const main = (id: string, mtimeMs: number, dir = '-w'): SourceFile =>
  ({ path: `/p/${dir}/${id}.jsonl`, sessionId: id, projectDir: dir, kind: 'session', mtimeMs, size: 10 });
const sub = (id: string, mtimeMs: number, dir = '-w'): SourceFile =>
  ({ path: `/p/${dir}/${id}/subagents/x.jsonl`, sessionId: id, projectDir: dir, kind: 'subagent', mtimeMs, size: 10 });

afterEach(() => { vi.useRealTimers(); });   // block body: useRealTimers() returns VitestUtils, and afterEach wants void

describe('LivenessTracker.sweep', () => {
  it('gates ACTIVE by the window (L6) and resolves state from the tail', async () => {
    const t0 = 100 * H;
    // 30 s quiet, not 60: exactly toolQuietMs is already "attention" (the threshold is ≥, spec §7).
    const h = harness([main('fresh', t0 - 30_000), main('old', t0 - 5 * H)], { '/p/-w/fresh.jsonl': 'awaiting-tool' }, t0);
    await h.tracker.sweep();
    expect([...h.tracker.liveness.keys()]).toEqual(['fresh']);
    expect(h.tracker.liveness.get('fresh')!.state).toEqual({ kind: 'running' });
    expect(h.reads).toEqual(['/p/-w/fresh.jsonl']);            // the old one was never read (L9)
    expect(h.changes).toHaveLength(1);
    expect(h.changes[0]!.membershipChanged).toBe(true);
  });

  it('a newer subagent keeps a session ACTIVE and supplies lastWriteMs, not the verdict (L7, L8)', async () => {
    const t0 = 100 * H;
    const h = harness([main('a', t0 - 6 * H), sub('a', t0 - 2 * MIN)], { '/p/-w/a.jsonl': 'awaiting-tool' }, t0);
    await h.tracker.sweep();
    const l = h.tracker.liveness.get('a')!;
    expect(l.lastWriteMs).toBe(t0 - 2 * MIN);
    expect(l.verdict).toBe('awaiting-tool');
    expect(h.reads).toEqual(['/p/-w/a.jsonl']);                // never the subagent file
  });

  it('reads the tail of the most recently written main copy after a worktree move (L8)', async () => {
    const t0 = 100 * H;
    const h = harness([main('a', t0 - 3 * H, '-w'), main('a', t0 - MIN, '-w2')],
                      { '/p/-w/a.jsonl': 'turn-ended', '/p/-w2/a.jsonl': 'awaiting-model' }, t0);
    await h.tracker.sweep();
    expect(h.reads).toEqual(['/p/-w2/a.jsonl']);
    expect(h.tracker.liveness.get('a')!.verdict).toBe('awaiting-model');
  });

  it('keeps a fresh session whose verdict is unknown (shown as running); drops one with only subagent files left', async () => {
    const t0 = 100 * H;
    const h = harness([main('u', t0), sub('orphan', t0)], {}, t0);
    await h.tracker.sweep();
    expect([...h.tracker.liveness.keys()]).toEqual(['u']);
    expect(h.tracker.liveness.get('u')).toMatchObject({ verdict: 'unknown', state: { kind: 'running' } });
  });
});

describe('LivenessTracker.tick', () => {
  it('re-reads only files whose (mtime, size) changed', async () => {
    const t0 = 100 * H;
    const files = [main('a', t0 - MIN), main('b', t0 - MIN)];
    const h = harness(files, { '/p/-w/a.jsonl': 'awaiting-tool', '/p/-w/b.jsonl': 'awaiting-tool' }, t0);
    await h.tracker.sweep();
    expect(h.reads).toHaveLength(2);
    await h.tracker.tick();
    expect(h.reads).toHaveLength(2);                            // nothing changed, nothing read
    files[0]!.mtimeMs = t0; files[0]!.size = 11;               // 'a' appended
    await h.tracker.tick();
    expect(h.reads).toEqual(['/p/-w/a.jsonl', '/p/-w/b.jsonl', '/p/-w/a.jsonl']);
  });

  it('a threshold crossing fires onChange with no I/O (spec §8)', async () => {
    const t0 = 100 * H;
    const h = harness([main('a', t0 - 30_000)], { '/p/-w/a.jsonl': 'awaiting-tool' }, t0);
    await h.tracker.sweep();
    expect(h.tracker.liveness.get('a')!.state).toEqual({ kind: 'running' });
    h.advance(40_000);                                          // quiet is now 70 s
    await h.tracker.tick();
    expect(h.reads).toHaveLength(1);
    expect(h.tracker.liveness.get('a')!.state).toEqual({ kind: 'attention', reason: 'tool-or-permission' });
    expect(h.changes).toHaveLength(2);
    expect(h.changes[1]!.membershipChanged).toBe(false);
  });

  it('does not emit when nothing changed', async () => {
    const t0 = 100 * H;
    const h = harness([main('a', t0 - MIN)], { '/p/-w/a.jsonl': 'turn-ended' }, t0);
    await h.tracker.sweep();
    await h.tracker.tick();
    h.advance(1_000);
    await h.tracker.tick();
    expect(h.changes).toHaveLength(1);
  });

  it('a file that vanished mid-tick is dropped for that cycle, not thrown', async () => {
    const t0 = 100 * H;
    const files = [main('a', t0 - MIN)];
    const h = harness(files, { '/p/-w/a.jsonl': 'turn-ended' }, t0);
    await h.tracker.sweep();
    files.splice(0, 1);                                         // stat now rejects with ENOENT
    await expect(h.tracker.tick()).resolves.toBeUndefined();
    expect(h.tracker.liveness.size).toBe(0);
  });
});

describe('LivenessTracker.start/stop', () => {
  it('runs a sweep+tick immediately, then on its intervals; stop() cancels', async () => {
    vi.useFakeTimers({ now: 100 * H });
    const t0 = 100 * H;
    const h = harness([main('a', t0 - MIN)], { '/p/-w/a.jsonl': 'awaiting-tool' }, t0);
    const sweep = vi.spyOn(h.tracker, 'sweep');
    const tick = vi.spyOn(h.tracker, 'tick');
    h.tracker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);                  // 5 ticks + 1 sweep elapsed
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(5);
    h.tracker.stop();
    const after = tick.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick.mock.calls.length).toBe(after);
  });

  it('routes a throwing phase to onError instead of an unhandled rejection', async () => {
    vi.useFakeTimers({ now: 100 * H });
    const deps: TrackerDeps = {
      discover: async () => { throw new Error('boom'); },
      stat: async () => ({ mtimeMs: 0, size: 0 }), readVerdict: async () => 'unknown', now: () => 100 * H,
    };
    const tracker = new LivenessTracker({ activeWindowMs: H }, deps);
    const errors: unknown[] = [];
    tracker.onError = e => errors.push(e);
    tracker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveLength(1);
    tracker.stop();
  });
});
