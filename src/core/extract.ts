import type { ProseMsg, SessionMeta, Role, PrLink, SlackLink, Worktree } from './types.js';
import type { SourceFile } from './discover.js';
import { actClock, type ActRec } from './acts.js';
import { isDefaultBranch, worktreeOf, slackLinks, aroundLinks } from './links.js';
import { isInside } from './paths.js';

export type BareProse = Omit<ProseMsg, 's'>;
export type BareMeta = Omit<SessionMeta, 'cwdExists' | 'extraFiles'>;

interface Part { type?: string; text?: string }
interface Line extends ActRec {
  type?: string; cwd?: string; gitBranch?: string; timestamp?: string;
  isSidechain?: boolean; isMeta?: boolean; aiTitle?: string; customTitle?: string;
  prNumber?: number; prRepository?: string; prUrl?: string;
  worktreeSession?: { worktreePath?: string; worktreeName?: string } | null;
  entrypoint?: string; sessionKind?: string;
  message?: { content?: string | Part[] };
}

/**
 * D15: Claude Code's own test for a session it keeps out of its history — an SDK entrypoint (`claude -p`
 * writes sdk-cli) or a daemon. The FIRST of each decides: a -p run later resumed in VS Code is still one.
 */
const SDK_ENTRYPOINTS = new Set(['sdk-cli', 'sdk-ts', 'sdk-py']);
const DAEMON_KINDS = new Set(['daemon', 'daemon-worker']);

function parse(line: string): Line | null {
  if (!line) return null;
  try { return JSON.parse(line) as Line; } catch { return null; }   // truncated tail line
}

/** Text parts only. tool_result / tool_use / thinking / image are all skipped by omission. */
function textParts(content: string | Part[] | undefined): string[] {
  if (typeof content === 'string') return content ? [content] : [];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const p of content) if (p?.type === 'text' && typeof p.text === 'string' && p.text) out.push(p.text);
  return out;
}

export function extractSession(file: SourceFile, text: string): { meta: BareMeta; prose: BareProse[] } {
  const prose: BareProse[] = [];
  const prs = new Map<string, PrLink>();
  const slack = new Map<string, SlackLink>();
  let cwd: string | null = null, launchCwd: string | null = null;
  let branchNow: string | null = null, workBranch: string | null = null;
  /** the last branch worked on inside a `.worktrees` folder — how deep that worktree goes (links.ts worktreeOf) */
  let dotWorktreeBranch: string | null = null;
  /** the worktree Claude Code says the session entered (EnterWorktree), until it leaves */
  let entered: Worktree | null = null;
  let aiTitle: string | null = null;
  let customTitle: string | null = null;      // L12: written by "Rename Session Tab"; beats every ai-title
  let firstTs = 0, lastTs = 0, msgCount = 0;
  let entrypoint: string | undefined, sessionKind: string | undefined;
  const acts = actClock();

  for (const raw of text.split('\n')) {
    const d = parse(raw);
    if (!d) continue;
    acts.see(d);
    if (entrypoint === undefined && typeof d.entrypoint === 'string') entrypoint = d.entrypoint;
    if (sessionKind === undefined && typeof d.sessionKind === 'string') sessionKind = d.sessionKind;

    if (typeof d.cwd === 'string' && d.cwd) { cwd = d.cwd; launchCwd ??= d.cwd; }   // LAST wins (F6)
    // A line in a worktree sometimes records the main checkout's branch (~7% of them): main and HEAD never count as work.
    if (typeof d.gitBranch === 'string' && d.gitBranch) {
      branchNow = d.gitBranch;
      if (!isDefaultBranch(d.gitBranch)) {
        workBranch = d.gitBranch;
        if (cwd && /[\\/]\.worktrees[\\/]/.test(cwd)) dotWorktreeBranch = d.gitBranch;
      }
    }
    if (d.type === 'worktree-state') {
      const w = d.worktreeSession;
      entered = w && typeof w.worktreePath === 'string' ? { name: w.worktreeName || w.worktreePath.split(/[\\/]/).pop()!, path: w.worktreePath } : null;
      continue;
    }

    const ts = d.timestamp ? Date.parse(d.timestamp) : NaN;
    if (!Number.isNaN(ts)) {
      if (!firstTs || ts < firstTs) firstTs = ts;
      if (ts > lastTs) lastTs = ts;
    }
    const t = Number.isNaN(ts) ? 0 : ts;

    if (d.type === 'ai-title' && d.aiTitle) { aiTitle = d.aiTitle; prose.push({ r: 't', t, x: d.aiTitle }); continue; }
    if (d.type === 'custom-title' && d.customTitle) { customTitle = d.customTitle; prose.push({ r: 't', t, x: d.customTitle }); continue; }
    if (d.type === 'pr-link' && typeof d.prNumber === 'number') {
      const repo = typeof d.prRepository === 'string' && d.prRepository ? d.prRepository : null;
      const key = `${repo ?? ''}#${d.prNumber}`;
      if (!prs.has(key)) prs.set(key, { n: d.prNumber, repo, url: typeof d.prUrl === 'string' && d.prUrl ? d.prUrl : null, ts: t, branch: workBranch });
      continue;
    }

    let role: Role | null = null;
    if (d.type === 'user') role = d.isSidechain ? 'sub' : 'u';
    else if (d.type === 'assistant') role = d.isSidechain ? 'sub' : 'a';
    if (!role) continue;

    for (const x of textParts(d.message?.content)) {
      prose.push({ r: role, t, x }); msgCount++;
      if (role !== 'u' || d.isMeta) continue;                         // Slack threads are the ones YOU pasted
      for (const s of slackLinks(x)) if (!slack.has(s.thread)) slack.set(s.thread, { ...s, ts: t, said: aroundLinks(x) });
    }
  }

  const worktree = !cwd ? null
    : entered && isInside(cwd, entered.path) ? entered
    : worktreeOf(cwd, dotWorktreeBranch);

  return {
    meta: {
      sessionId: file.sessionId, file: file.path, projectDir: file.projectDir,
      cwd, launchCwd, title: customTitle ?? aiTitle, branch: workBranch ?? branchNow, branchNow, worktree,
      prs: [...prs.values()], slack: [...slack.values()],
      firstTs, lastTs, lastActTs: acts.last ?? 0, msgCount, mtimeMs: file.mtimeMs, size: file.size,
      headless: SDK_ENTRYPOINTS.has(entrypoint ?? '') || DAEMON_KINDS.has(sessionKind ?? ''),
    },
    prose,
  };
}

/** Subagent transcripts contribute prose only; their metadata belongs to the parent. */
export function extractSubagent(_file: SourceFile, text: string): BareProse[] {
  const out: BareProse[] = [];
  for (const raw of text.split('\n')) {
    const d = parse(raw);
    if (!d || (d.type !== 'user' && d.type !== 'assistant')) continue;
    const ts = d.timestamp ? Date.parse(d.timestamp) : NaN;
    for (const x of textParts(d.message?.content)) out.push({ r: 'sub', t: Number.isNaN(ts) ? 0 : ts, x });
  }
  return out;
}
