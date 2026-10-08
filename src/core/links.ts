// Where a session's work is and what it links to, read from what its transcript records: the branch,
// the worktree, the project, and the Slack threads you pasted. Pure; extract.ts feeds it line by line.
import type { Worktree } from './types.js';

/** main, master and a detached HEAD are where work starts and returns to, not where it is. */
export const isDefaultBranch = (b: string): boolean => b === 'main' || b === 'master' || b === 'HEAD';

const lastSegment = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** A worktree named like its branch says nothing the branch doesn't: `deck-editor-spec` on `shobhit/deck-editor-spec`. */
export function sameAsBranch(worktree: string, branch: string | null): boolean {
  if (!branch) return false;
  return worktree === branch || worktree === lastSegment(branch) || branch === `worktree-${worktree}` || worktree === branch.replace(/\//g, '-');
}

const CLAUDE_WORKTREE = /^(.*?[\\/]\.claude[\\/]worktrees[\\/][^\\/]+)/;
const DOT_WORKTREES = /^(.*?[\\/]\.worktrees)[\\/](.+)$/;

/**
 * The linked worktree a cwd is in: `<repo>/.claude/worktrees/<name>` (Claude Code's own), or a folder under
 * `<repo>/.worktrees/`. A branch with a slash is often checked out as nested folders there
 * (`.worktrees/shobhit/deck-editor-spec`), so `branch` — the one recorded inside it — says how deep the
 * worktree goes; otherwise it is the first folder. Null for a main checkout.
 */
export function worktreeOf(cwd: string, branch: string | null): Worktree | null {
  const claude = CLAUDE_WORKTREE.exec(cwd);
  if (claude) return { name: lastSegment(claude[1]!), path: claude[1]! };
  const dot = DOT_WORKTREES.exec(cwd);
  if (!dot) return null;
  const rest = dot[2]!.replace(/[\\/]+$/, '');
  const root = branch && !isDefaultBranch(branch) && (rest === branch || rest.startsWith(`${branch}/`)) ? branch : rest.split(/[\\/]/)[0]!;
  return { name: lastSegment(root), path: cwd.slice(0, dot[1]!.length + 1 + root.length) };
}

/** The project a session belongs to: the folder it was started in, named for its main checkout when that was a worktree. */
export function projectName(launchCwd: string | null): string | null {
  if (!launchCwd) return null;
  return lastSegment(launchCwd.replace(/[\\/]\.(?:claude[\\/])?worktrees[\\/].*$/, '')) || null;
}

/** A link to a Slack message: `https://<team>.slack.com/archives/<channel>/p<ts>`, a reply's carrying `?thread_ts=`. */
const SLACK_MESSAGE = /https:\/\/[A-Za-z0-9-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{16})(\?[^\s<>()[\]"'`]*)?/g;

export interface SlackHit {
  url: string;
  /** `<channel>/<thread ts>`: a reply and its parent are the same thread */
  thread: string;
}

export function slackLinks(text: string): SlackHit[] {
  const out: SlackHit[] = [];
  for (const m of text.matchAll(SLACK_MESSAGE)) {
    const query = (m[3] ?? '').replace(/[.,;:!?]+$/, '');
    const url = m[0].slice(0, m[0].length - (m[3] ?? '').length) + (query === '?' ? '' : query);
    const ts = /[?&]thread_ts=(\d+\.\d+)/.exec(query)?.[1] ?? `${m[2]!.slice(0, 10)}.${m[2]!.slice(10)}`;
    out.push({ url, thread: `${m[1]}/${ts}` });
  }
  return out;
}

const ANY_URL = /https?:\/\/\S+/g;
const SAID_MAX = 120;

/** What you wrote around the links in a prompt — the tooltip says why you pasted it. */
export function aroundLinks(text: string): string {
  const said = text.replace(ANY_URL, ' … ').replace(/\s+/g, ' ').trim().replace(/^…\s*|\s*…$/g, '').trim();
  return said.length > SAID_MAX ? `${said.slice(0, SAID_MAX - 1)}…` : said;
}
