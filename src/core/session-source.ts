/**
 * What the Session View reads from disk, kept apart from the panel so it can be tested without VS Code.
 *
 * A workflow session can have hundreds of agent transcripts and a 30 MB main file, all of them growing while
 * it runs. So: transcripts are append-only and each read parses only the bytes added since the last one;
 * the session's own subagents folders are listed, not every project's; and at most one update is on its way
 * to the webview at a time — VS Code keeps every message the other side has not acknowledged, and while the
 * laptop sleeps nothing is acknowledged (a 3 MB update every 2 s grew the extension host until it was killed).
 */
import { open, stat } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { discoverSubagents, defaultRoot } from './discover.js';
import { parseRecords, type Rec } from './transcript.js';
import type { AgentFile, JournalRec } from './agents.js';

export interface Tailed { mtimeMs: number; size: number; recs: Rec[] }
interface Entry extends Tailed { offset: number }
const NL = 0x0a;

/** JSONL files read incrementally: each read parses only what was appended since the last one. */
export class JsonlTails {
  private readonly files = new Map<string, Entry>();
  /** Bytes read from disk so far — what the tests and the load harness measure. */
  bytesRead = 0;

  get(path: string): Tailed | undefined { return this.files.get(path); }
  clear(): void { this.files.clear(); }
  /** Forget every file but these — an agent's transcript that is gone from disk lets its records go. */
  keepOnly(paths: ReadonlySet<string>): void { for (const p of this.files.keys()) if (!paths.has(p)) this.files.delete(p); }

  /**
   * The file's records and whether they changed (by mtime:size) since the last read; undefined when it is gone.
   * Only whole lines are consumed — a line still being written is read again, complete, next time — and a
   * file that shrank is read again from the start.
   */
  async read(path: string, known?: { mtimeMs: number; size: number }): Promise<{ file: Tailed; changed: boolean } | undefined> {
    const s = known ?? await stat(path).catch(() => null);
    if (!s) { this.files.delete(path); return undefined; }
    let e = this.files.get(path);
    if (e && e.mtimeMs === s.mtimeMs && e.size === s.size) return { file: e, changed: false };
    if (!e || s.size < e.offset) e = { mtimeMs: 0, size: 0, offset: 0, recs: [] };
    const len = s.size - e.offset;
    let size = s.size;
    if (len > 0) {
      const buf = Buffer.alloc(len);
      let got = 0;
      try {
        const fh = await open(path, 'r');
        try { got = (await fh.read(buf, 0, len, e.offset)).bytesRead; } finally { await fh.close(); }
      } catch { this.files.delete(path); return undefined; }
      this.bytesRead += got;
      const chunk = buf.subarray(0, got);
      const nl = chunk.lastIndexOf(NL);
      let used = nl + 1;                                       // a newline byte is never inside a multi-byte character
      for (const r of parseRecords(chunk.subarray(0, used).toString('utf8'))) e.recs.push(r);
      const rest = chunk.subarray(used).toString('utf8').trim();
      if (rest) {                                              // a last line with no newline yet: whole if it parses (no prefix of an object line does)
        try { e.recs.push(JSON.parse(rest) as Rec); used = got; } catch { /* still being written */ }
      }
      size = e.offset + got;                                   // less than stat said if it shrank meanwhile: the next read looks again
      e.offset += used;
    }
    e.mtimeMs = s.mtimeMs; e.size = size;
    this.files.set(path, e);
    return { file: e, changed: true };
  }
}

const agentIdOf = (p: string): string => basename(p, '.jsonl').replace(/^agent-/, '');
/** `…/subagents/workflows/<runId>/agent-x.jsonl` → runId */
export function runIdOf(p: string): string | undefined {
  const parts = p.split(sep);
  const i = parts.lastIndexOf('workflows');
  return i >= 0 && i + 2 < parts.length ? parts[i + 1] : undefined;
}

export interface Loaded {
  main: Tailed; agents: AgentFile[]; journals: Record<string, JournalRec[]>;
  /** The files whose records changed since the last load — an update re-sends a node's page only when its file is one. */
  changed: Set<string>;
}

/** A session's main transcript, its subagents' and its workflows' journals, as of now. */
export class SessionSource {
  readonly tails = new JsonlTails();

  constructor(private readonly sessionId: string, private readonly mainFile: string, private readonly root: string = defaultRoot()) {}

  /** The records last read from `path`, if it is one of this session's files. */
  recs(path: string): Rec[] | undefined { return this.tails.get(path)?.recs; }

  /** Undefined when the main transcript is no longer on disk. */
  async load(): Promise<Loaded | undefined> {
    const main = await this.tails.read(this.mainFile);
    if (!main) return undefined;
    const changed = new Set<string>(main.changed ? [this.mainFile] : []);
    const seen = new Set<string>([this.mainFile]);
    const agents: AgentFile[] = [];
    const journalPaths = new Map<string, string>();
    // a workflow's journal.jsonl sits beside its agents' files but is bookkeeping, not an agent (it was listed as one, "journal")
    for (const f of await discoverSubagents(this.sessionId, this.root)) {
      if (basename(f.path) === 'journal.jsonl') continue;
      const c = await this.tails.read(f.path, f); if (!c) continue;
      seen.add(f.path);
      if (c.changed) changed.add(f.path);
      const runId = runIdOf(f.path);
      agents.push({ path: f.path, agentId: agentIdOf(f.path), recs: c.file.recs, mtimeMs: c.file.mtimeMs, ...(runId ? { runId } : {}) });
      if (runId && !journalPaths.has(runId)) journalPaths.set(runId, join(dirname(f.path), 'journal.jsonl'));
    }
    const journals: Record<string, JournalRec[]> = {};
    for (const [runId, jp] of journalPaths) {
      const c = await this.tails.read(jp);
      if (c) { seen.add(jp); if (c.changed) changed.add(jp); journals[runId] = c.file.recs as JournalRec[]; }
    }
    this.tails.keepOnly(seen);
    return { main: main.file, agents, journals, changed };
  }
}

/**
 * The live update loop's pacing: a tick reads and sends only when nothing is in flight — the webview
 * acknowledges each init/update once it has applied it. A sleeping laptop therefore holds at most one
 * update in VS Code's unacknowledged-message queue, however long it sleeps and whatever `visible` says.
 */
export class SessionFeed {
  private busy = false;
  /** The seq of the init/update the webview has not acknowledged yet, if any. */
  private unacked: number | undefined;
  private seq = 0;
  private last: Loaded | undefined;

  constructor(private readonly source: SessionSource, private readonly opts: {
    live: () => boolean;
    /** Builds and posts the init/update for what was loaded; the webview acknowledges it with `seq`. */
    send: (loaded: Loaded, kind: 'init' | 'update', seq: number) => void;
    /** The main transcript is gone. */
    missing: () => void;
  }) {}

  /** Whether an update is waiting for the webview's acknowledgement. */
  get waiting(): boolean { return this.unacked !== undefined; }

  /** The webview applied init/update `seq`; an older one's acknowledgement does not free the way for the next. */
  ack(seq: number): void { if (seq === this.unacked) this.unacked = undefined; }

  /** Posts, and waits for the acknowledgement only once it has been posted: a build that throws must not stop the ticks. */
  private post(loaded: Loaded, kind: 'init' | 'update'): void {
    const seq = ++this.seq;
    this.opts.send(loaded, kind, seq);
    this.unacked = seq;
  }

  /** The webview (re)started: the last snapshot again, if there is one yet — the first load posts its own. */
  resend(): void {
    if (this.last) this.post(this.last, 'init');
  }

  /** A timer tick: a live session's changes, if the webview has taken the last ones. */
  async tick(): Promise<void> {
    if (this.unacked !== undefined || !this.opts.live()) return;            // finished sessions don't change
    await this.load(false);
  }

  /** Re-read what changed and post it; `force` posts an init even when nothing changed (open, refresh, a reloaded webview). */
  async load(force: boolean): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const loaded = await this.source.load();
      if (!loaded) { this.opts.missing(); return; }
      if (!force && !loaded.changed.size) return;
      this.last = loaded;
      this.post(loaded, force ? 'init' : 'update');
    } finally {
      this.busy = false;
    }
  }
}
