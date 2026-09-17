import * as vscode from 'vscode';
import { join } from 'node:path';
import { LivenessTracker } from './core/live.js';
import { refreshIndex } from './core/cache.js';
import { durationMs } from './core/query.js';
import { buildSnapshot, type Snapshot } from './core/rows.js';
import type { SearchIndex } from './core/types.js';
import type { Liveness } from './core/state.js';

const HOUR = 3_600_000;

/**
 * The vscode-aware owner of live state (spec D4, D6). Turns settings into a LivenessTracker,
 * pauses it while the window is unfocused, refreshes the search index only when ACTIVE
 * membership changes (L9), and emits a Snapshot for every surface to render.
 */
export class LiveHost implements vscode.Disposable {
  private tracker: LivenessTracker | undefined;
  private unsubscribe: (() => void) | undefined;
  private index: SearchIndex | null = null;
  private indexing: Promise<void> | null = null;
  private readonly emitter = new vscode.EventEmitter<Snapshot>();
  private readonly disposables: vscode.Disposable[] = [this.emitter];

  readonly onSnapshot: vscode.Event<Snapshot> = this.emitter.event;
  snapshot: Snapshot = { active: [], history: [], totalSessions: 0, indexing: true };

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly log: vscode.LogOutputChannel) {
    this.rebuildTracker();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('sessionFinder')) this.rebuildTracker();
      }),
      // D6: nothing runs while the window is unfocused; the first focus event sweeps at once.
      vscode.window.onDidChangeWindowState(s => (s.focused ? this.tracker?.start() : this.tracker?.stop())),
    );
    void this.refreshIndex();
  }

  get liveness(): ReadonlyMap<string, Liveness> { return this.tracker?.liveness ?? new Map(); }

  private rebuildTracker(): void {
    this.tracker?.stop();
    this.unsubscribe?.();
    const c = vscode.workspace.getConfiguration('sessionFinder');
    const tracker = new LivenessTracker({
      activeWindowMs: durationMs(c.get<string>('activeWindow', '4h'), 4 * HOUR),
      thresholds: {
        toolQuietMs: Math.max(5, c.get<number>('toolQuietSeconds', 60)) * 1_000,
        stalledMs: Math.max(1, c.get<number>('stalledMinutes', 15)) * 60_000,
      },
    });
    tracker.onError = err => this.log.warn(`live tracker: ${String(err)}`);
    this.unsubscribe = tracker.onChange(({ membershipChanged }) => {
      if (membershipChanged) void this.refreshIndex();          // a session appeared or left (D6)
      this.publish();
    });
    this.tracker = tracker;
    if (vscode.window.state.focused) tracker.start();
  }

  /** Whole-file work (L9) — never from a tick. Concurrent callers share one run. */
  refreshIndex(): Promise<void> {
    if (this.indexing) return this.indexing;
    this.indexing = (async () => {
      try {
        ({ index: this.index } = await refreshIndex({ cacheFile: join(this.ctx.globalStorageUri.fsPath, 'index.json') }));
      } catch (err) {
        this.log.warn(`index refresh failed: ${String(err)}`);
      } finally {
        this.indexing = null;
        this.publish();
      }
    })();
    return this.indexing;
  }

  private publish(): void {
    this.snapshot = buildSnapshot(this.index, this.liveness, { indexing: this.indexing !== null });
    this.emitter.fire(this.snapshot);
  }

  dispose(): void {
    this.tracker?.stop();
    this.unsubscribe?.();
    for (const d of this.disposables) d.dispose();
  }
}
