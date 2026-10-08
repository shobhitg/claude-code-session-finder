export const INDEX_VERSION = 5;

/** 'u' your prompt · 'a' Claude prose · 't' session title · 'sub' subagent prose */
export type Role = 'u' | 'a' | 't' | 'sub';

export interface SessionMeta {
  sessionId: string;
  file: string;
  /**
   * Further transcript files that belong to this session: its subagent transcripts, plus
   * any duplicate-sessionId copy that lost the merge in cache.ts. Deep search reads these
   * as well as `file`; assembled from the cache's `files` map, never persisted.
   */
  extraFiles: string[];
  /** Sanitized ~/.claude/projects dir name. GROUPING HINT ONLY — never a path (F6). */
  projectDir: string;
  /** LAST cwd recorded in the file (F6). */
  cwd: string | null;
  cwdExists: boolean;
  /** FIRST cwd recorded — where the session was started, which names its project (links.ts projectName). */
  launchCwd: string | null;
  title: string | null;
  /** The branch it last worked on: the last one recorded that is not main, master or a detached HEAD — else the last one recorded. */
  branch: string | null;
  /** The last branch recorded: where it is now. */
  branchNow: string | null;
  /** The linked worktree its last cwd is in, if any. */
  worktree: Worktree | null;
  /** Every PR linked to it, in the order first linked. */
  prs: PrLink[];
  /** Every Slack thread you pasted into it, in the order first pasted. */
  slack: SlackLink[];
  /** From message timestamps, not file mtime. */
  firstTs: number;
  lastTs: number;
  /** When you last did something to it (core/acts.ts) — 0 if you never did. The sidebar's order (D14). */
  lastActTs: number;
  /** Started without a UI — `claude -p`, the Agent SDK, a daemon (D15). Claude Code's tab cannot show these. */
  headless: boolean;
  msgCount: number;
  mtimeMs: number;
  size: number;
}

/** A linked worktree: its folder name and where it is. */
export interface Worktree { name: string; path: string }

/** A PR Claude Code linked to the session (a `pr-link` record): the ones it started from and the ones it opened. */
export interface PrLink {
  n: number;
  /** `owner/name`, when recorded */
  repo: string | null;
  url: string | null;
  /** when it was first linked */
  ts: number;
  /** the branch the session last worked on when it was linked — a guess at the PR's head; GitHub's answer wins */
  branch: string | null;
}

/** A Slack thread you pasted into a prompt — one per thread, however many of its messages you linked. */
export interface SlackLink {
  url: string;
  /** `<channel>/<thread ts>` (links.ts slackLinks) */
  thread: string;
  /** when you first pasted it */
  ts: number;
  /** what you wrote around it */
  said: string;
}

export interface ProseMsg {
  /** index into SearchIndex.sessions */
  s: number;
  r: Role;
  t: number;
  x: string;
}

export interface SearchIndex {
  v: number;
  builtAt: number;
  sessions: SessionMeta[];
  prose: ProseMsg[];
}
