import { stat as fsStat } from 'node:fs/promises';
import { discover as fsDiscover, defaultRoot, type SourceFile } from './discover.js';
import {
  readVerdict as fsReadVerdict, effectiveMtime, pickMainFile, resolveState,
  DEFAULT_THRESHOLDS, type Liveness, type TailVerdict, type Thresholds,
} from './state.js';

export interface TrackerDeps {
  discover: (root: string) => Promise<SourceFile[]>;
  stat: (path: string) => Promise<{ mtimeMs: number; size: number }>;
  readVerdict: (path: string, size: number) => Promise<TailVerdict>;
  now: () => number;
}

export interface TrackerOptions {
  root?: string;
  /** L6: sessions written within this window are ACTIVE and carry a state. */
  activeWindowMs: number;
  thresholds?: Thresholds;
  sweepMs?: number;
  tickMs?: number;
}

export type LivenessMap = ReadonlyMap<string, Liveness>;
export interface Change { liveness: LivenessMap; membershipChanged: boolean }

interface Tracked {
  sessionId: string;
  files: SourceFile[];
  main: SourceFile;
  /** `${mtimeMs}:${size}` of `main` when its tail was last read — the same key cache.ts uses. */
  key: string;
  verdict: TailVerdict;
}

const keyOf = (f: { mtimeMs: number; size: number }) => `${f.mtimeMs}:${f.size}`;

/**
 * Spec §8. Two phases over an in-memory picture of the ACTIVE set:
 *   sweep  — discover() everything (readdir + stat), recompute membership, read tails of NEW members
 *   tick   — re-stat ACTIVE files, re-read only tails whose (mtime, size) changed, re-resolve all
 * Publishes only when the resulting map differs (membership, verdict, state, reason, lastWriteMs).
 * No `vscode`, no real clock: everything comes through `deps`, so tests drive it deterministically.
 */
export class LivenessTracker {
  private tracked = new Map<string, Tracked>();
  private current = new Map<string, Liveness>();
  private readonly listeners = new Set<(c: Change) => void>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private readonly root: string;
  private readonly thresholds: Thresholds;
  private readonly sweepMs: number;
  private readonly tickMs: number;

  /** Spec §12: a timer callback never throws. Whatever a phase throws lands here (or is dropped). */
  onError: ((err: unknown) => void) | undefined;

  constructor(private readonly opts: TrackerOptions, private readonly deps: TrackerDeps = defaultDeps()) {
    this.root = opts.root ?? defaultRoot();
    this.thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
    this.sweepMs = opts.sweepMs ?? 10_000;
    this.tickMs = opts.tickMs ?? 2_000;
  }

  get liveness(): LivenessMap { return this.current; }

  onChange(cb: (c: Change) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  async sweep(): Promise<void> {
    const files = await this.deps.discover(this.root);
    const bySession = new Map<string, SourceFile[]>();
    for (const f of files) {
      const group = bySession.get(f.sessionId) ?? [];
      group.push(f);
      bySession.set(f.sessionId, group);
    }
    const now = this.deps.now();
    const next = new Map<string, Tracked>();
    for (const [sessionId, group] of bySession) {
      if (now - effectiveMtime(group) > this.opts.activeWindowMs) continue;          // L6, L7
      const main = pickMainFile(group);                                              // L8
      if (!main) continue;                                                           // parent transcript gone
      const key = keyOf(main);
      const prev = this.tracked.get(sessionId);
      const verdict = prev && prev.key === key && prev.main.path === main.path
        ? prev.verdict
        : await this.deps.readVerdict(main.path, main.size);
      next.set(sessionId, { sessionId, files: group, main, key, verdict });
    }
    const membershipChanged = next.size !== this.tracked.size || [...next.keys()].some(k => !this.tracked.has(k));
    this.tracked = next;
    this.publish(membershipChanged);
  }

  async tick(): Promise<void> {
    for (const [sessionId, t] of this.tracked) {
      const fresh: SourceFile[] = [];
      for (const f of t.files) {
        const s = await this.deps.stat(f.path).catch(() => null);                    // §12: vanished → skip
        if (s) fresh.push({ ...f, mtimeMs: s.mtimeMs, size: s.size });
      }
      const main = pickMainFile(fresh);
      if (!main) { this.tracked.delete(sessionId); continue; }
      t.files = fresh;
      const key = keyOf(main);
      if (key !== t.key || main.path !== t.main.path) {                              // changed → one tail read
        t.verdict = await this.deps.readVerdict(main.path, main.size);
        t.key = key;
        t.main = main;
      }
    }
    this.publish(false);
  }

  start(): void {
    this.stop();
    void this.run(async () => { await this.sweep(); await this.tick(); });
    this.sweepTimer = setInterval(() => void this.run(() => this.sweep()), this.sweepMs);
    this.tickTimer = setInterval(() => void this.run(() => this.tick()), this.tickMs);
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.sweepTimer = this.tickTimer = undefined;
  }

  private publish(membershipChanged: boolean): void {
    const now = this.deps.now();
    const next = new Map<string, Liveness>();
    for (const t of this.tracked.values()) {
      const lastWriteMs = effectiveMtime(t.files);
      const state = resolveState(t.verdict, now - lastWriteMs, this.thresholds);
      if (!state) continue;                                                          // unknown → not ACTIVE
      next.set(t.sessionId, { sessionId: t.sessionId, verdict: t.verdict, state, lastWriteMs });
    }
    const changed = membershipChanged || !sameLiveness(this.current, next);
    this.current = next;
    if (changed) for (const cb of this.listeners) cb({ liveness: next, membershipChanged });
  }

  /** Phases never overlap (a slow sweep skips the ticks under it) and never throw out of a timer. */
  private async run(phase: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try { await phase(); } catch (err) { this.onError?.(err); } finally { this.busy = false; }
  }
}

function sameLiveness(a: ReadonlyMap<string, Liveness>, b: ReadonlyMap<string, Liveness>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, x] of a) {
    const y = b.get(k);
    if (!y || x.verdict !== y.verdict || x.lastWriteMs !== y.lastWriteMs || x.state.kind !== y.state.kind) return false;
    if (x.state.kind === 'attention' && y.state.kind === 'attention' && x.state.reason !== y.state.reason) return false;
  }
  return true;
}

function defaultDeps(): TrackerDeps {
  return {
    discover: fsDiscover,
    stat: async p => { const s = await fsStat(p); return { mtimeMs: s.mtimeMs, size: s.size }; },
    readVerdict: fsReadVerdict,
    now: () => Date.now(),
  };
}
