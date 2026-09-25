import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Liveness } from './state.js';

/**
 * The bell (D13) rings while the ball is in your court and you have not seen it there. A look is a
 * session on screen — its Claude Code tab the visible tab of an editor group, or its Session View
 * visible — in a focused window, while the session waits on you. `at`: session id → the last such look;
 * `since`: when looks began to be recorded, so nothing written before then rings.
 */
export interface Looks { since: number; at: Readonly<Record<string, number>> }

/** A look at a session that has left ACTIVE is kept this long, then forgotten. */
export const LOOKS_KEEP_MS = 7 * 24 * 3_600_000;

/**
 * Whether a session rings. A question (or a plan to approve) is sticky: it rings until Claude moves
 * again. Your turn, an interruption and a quiet tool call — which may be a permission prompt, or only a
 * long command — ring until you look after they land. Running and stalled never: the ball is not with you.
 */
export function rings(l: Pick<Liveness, 'sessionId' | 'state' | 'lastWriteMs'>, looks: Looks): boolean {
  if (l.state.kind !== 'attention') return false;
  if (l.state.reason === 'question') return true;
  if (l.state.reason === 'stalled') return false;
  return l.lastWriteMs > Math.max(looks.at[l.sessionId] ?? 0, looks.since);
}

/**
 * Record a look at each session on screen that waits on you and was last seen before it landed. A look
 * while Claude works does not count — you saw it working, not what it left you. The same object comes
 * back when nothing changed, so the caller knows there is nothing to write.
 */
export function stampLooks(looks: Looks, onScreen: Iterable<string>, live: ReadonlyMap<string, Liveness>, now: number): Looks {
  let at: Record<string, number> | undefined;
  for (const id of onScreen) {
    const l = live.get(id);
    if (!l || l.state.kind !== 'attention' || (looks.at[id] ?? -Infinity) >= l.lastWriteMs) continue;
    (at ??= { ...looks.at })[id] = now;
  }
  return at ? { since: looks.since, at } : looks;
}

/** Two windows' looks: the later look per session, the later start. */
export function mergeLooks(a: Looks, b: Looks): Looks {
  const at: Record<string, number> = { ...a.at };
  for (const [id, t] of Object.entries(b.at)) if (!(id in at) || t > at[id]!) at[id] = t;
  return { since: Math.max(a.since, b.since), at };
}

/** Forget a session once it is not live and its last look is older than LOOKS_KEEP_MS. */
export function pruneLooks(looks: Looks, live: ReadonlySet<string>, now: number): Looks {
  const at: Record<string, number> = {};
  for (const [id, t] of Object.entries(looks.at)) if (live.has(id) || now - t <= LOOKS_KEEP_MS) at[id] = t;
  return { since: looks.since, at };
}

/** The stored shape, or null. Entries that are not a number are dropped. */
export function parseLooks(text: string): Looks | null {
  let o: unknown;
  try { o = JSON.parse(text); } catch { return null; }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return null;
  const { since, at } = o as { since?: unknown; at?: unknown };
  if (typeof since !== 'number' || !Number.isFinite(since) || typeof at !== 'object' || at === null) return null;
  const out: Record<string, number> = {};
  for (const [id, t] of Object.entries(at)) if (typeof t === 'number' && Number.isFinite(t)) out[id] = t;
  return { since, at: out };
}

export interface LooksIo { read(path: string): string; write(path: string, text: string): Promise<void> }

const fsIo: LooksIo = {
  read: p => readFileSync(p, 'utf8'),
  // Through a temporary file and a rename, so another window never reads half a file.
  write: async (p, text) => {
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    await writeFile(tmp, text);
    await rename(tmp, p);
  },
};

/**
 * The looks, in one small JSON file under the extension's global storage that every window reads and
 * writes: a look in one window quiets the bell in all of them. Reading is synchronous (the file is tiny
 * and the host needs it before its first snapshot); a missing or corrupt file starts the looks now, and
 * that start is written at once, so a reload does not move it. Saving merges with the file first.
 */
export class LooksFile {
  constructor(private readonly path: string, private readonly io: LooksIo = fsIo) {}

  read(now: number): Looks {
    const looks = this.peek();
    if (looks) return looks;
    const fresh: Looks = { since: now, at: {} };
    void this.io.write(this.path, JSON.stringify(fresh)).catch(() => {});
    return fresh;
  }

  /** What the file says now, or null when it is missing or unreadable — nothing is created. */
  peek(): Looks | null {
    let text: string | undefined;
    try { text = this.io.read(this.path); } catch { return null; }
    return parseLooks(text);
  }

  /**
   * Merge with the file and write. Two windows saving at the same instant can still overwrite each
   * other's newest look; the loser keeps it in memory and writes it again with its next save.
   */
  async save(looks: Looks): Promise<Looks> {
    const theirs = this.peek();
    const merged = theirs ? mergeLooks(looks, theirs) : looks;
    await this.io.write(this.path, JSON.stringify(merged));
    return merged;
  }
}

/**
 * What the host asks before every snapshot (D13). It holds the looks and which sessions are on screen;
 * `update` takes in what other windows wrote (the file is tiny, and only a focused window reads it),
 * records the looks this moment makes — before answering, so a reply that lands while you watch never
 * rings, not even for one snapshot — and returns the rule for this snapshot. A new look is written to
 * the shared file at once.
 */
export class Bell {
  private looks: Looks;
  private onScreen: ReadonlySet<string> = new Set();

  constructor(private readonly file: LooksFile, private readonly now: () => number = Date.now) {
    this.looks = file.read(now());
  }

  /** The sessions on screen in this window now. True when the set changed, so the host republishes only then. */
  setOnScreen(ids: ReadonlySet<string>): boolean {
    if (ids.size === this.onScreen.size && [...ids].every(id => this.onScreen.has(id))) return false;
    this.onScreen = new Set(ids);
    return true;
  }

  /** A window without focus records nothing: a tab left on screen behind another app is not being read. */
  update(live: ReadonlyMap<string, Liveness>, focused: boolean): (l: Liveness) => boolean {
    if (focused) {
      const theirs = this.file.peek();
      if (theirs) this.looks = mergeLooks(this.looks, theirs);
      const now = this.now();
      const next = stampLooks(this.looks, this.onScreen, live, now);
      if (next !== this.looks) {
        this.looks = pruneLooks(next, new Set(live.keys()), now);
        void this.file.save(this.looks).then(m => { this.looks = mergeLooks(this.looks, m); }, () => {});
      }
    }
    const looks = this.looks;
    return l => rings(l, looks);
  }
}
