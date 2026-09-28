import { readdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The Claude Code processes alive on this machine, from the registry Claude Code keeps at
 * `~/.claude/sessions/<pid>.json` (one file per interactive process, removed on a clean exit).
 * Undocumented: every field is checked, and a missing or unreadable registry means "unknown",
 * never "nothing is running".
 *
 * Why it matters: nothing stops two processes resuming one session. Both append to the same
 * transcript, it forks, and the next resume follows only the branch written last — the other
 * one's work drops out of the conversation (it stays in the file). Opening a session from this
 * extension is the easy way to get there, so an open first asks the registry.
 */
export interface ClaudeProcess {
  pid: number;
  sessionId: string;
  /** Linux: field 22 of /proc/<pid>/stat at start — tells a live process from a reused pid */
  procStart?: string;
  entrypoint?: string;   // 'claude-vscode' | 'cli' | ...
  kind?: string;         // 'interactive' | ...
  status?: string;       // 'idle' | 'busy'
  name?: string;
  cwd?: string;
}

export const registryDir = () => join(homedir(), '.claude', 'sessions');

export function parseRegistryEntry(text: string): ClaudeProcess | null {
  let o: Record<string, unknown>;
  try { o = JSON.parse(text) as Record<string, unknown>; } catch { return null; }
  if (typeof o !== 'object' || o === null) return null;
  const { pid, sessionId } = o;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || typeof sessionId !== 'string' || !sessionId) return null;
  const str = (k: string) => (typeof o[k] === 'string' ? o[k] as string : undefined);
  const p: ClaudeProcess = { pid, sessionId };
  for (const k of ['procStart', 'entrypoint', 'kind', 'status', 'name', 'cwd'] as const) {
    const v = str(k);
    if (v !== undefined) p[k] = v;
  }
  return p;
}

/** What the OS says about a pid. `undefined` fields are unknown on this platform, not false. */
export interface ProcInfo { alive: boolean; start?: string; ppid?: number }

/**
 * Linux reads /proc/<pid>/stat: fields after the `)` that closes the command name, so a name
 * with spaces or parentheses cannot shift them. Elsewhere only liveness is known (signal 0;
 * EPERM means it exists but is someone else's).
 */
export function procInfo(pid: number): ProcInfo {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { alive: true, ppid: Number(rest[1]), start: rest[19] };
  } catch { /* no /proc, or no such pid */ }
  if (process.platform === 'linux') return { alive: false };
  try { process.kill(pid, 0); return { alive: true }; } catch (e) {
    return { alive: (e as NodeJS.ErrnoException).code === 'EPERM' };
  }
}

/** A registry entry is live when its pid is, and — where both sides know it — it started when the entry says. */
export function isLive(p: ClaudeProcess, info: ProcInfo): boolean {
  if (!info.alive) return false;
  return p.procStart === undefined || info.start === undefined || p.procStart === info.start;
}

/** The live entries, or null when the registry cannot be read at all (unknown, not empty). */
export async function readLiveProcesses(
  dir = registryDir(), info: (pid: number) => ProcInfo = procInfo,
): Promise<Array<ClaudeProcess & { ppid?: number }> | null> {
  let names: string[];
  try { names = await readdir(dir); } catch { return null; }
  const out: Array<ClaudeProcess & { ppid?: number }> = [];
  // Only <pid>.json — the <pid>.<hash>.key files beside them hold peer tokens and are never read.
  for (const n of names.filter(n => /^\d+\.json$/.test(n))) {
    const p = parseRegistryEntry(await readFile(join(dir, n), 'utf8').catch(() => ''));
    if (!p) continue;
    const i = info(p.pid);
    if (isLive(p, i)) out.push(i.ppid === undefined ? p : { ...p, ppid: i.ppid });
  }
  return out;
}

export type OpenConflict =
  | { kind: 'none' }
  /** the registry could not be read: behave as before, without a warning */
  | { kind: 'unknown' }
  /** live elsewhere: a terminal, another VS Code window, this window's side panel, a background session */
  | { kind: 'elsewhere'; processes: ClaudeProcess[] };

/**
 * Would opening `sessionId` in this window start a second process on it?
 *
 * Claude Code's editor.open focuses a TAB of this window that already has the session
 * (`createPanel` looks it up among its tab panels) — but not the side panel: a session running
 * there gets a second process in a new tab. So a process of this window (its parent is this
 * extension host, `selfPid`: Claude Code spawns one child per tab or panel from the host both
 * extensions share) is no conflict only when `hasTabHere` — this window certainly has a Claude
 * Code tab of the session, which is what editor.open will focus. Any other live process is a
 * conflict. Where the parent is unknown (no /proc), a VS Code process may be this window's tab,
 * so only the ones that certainly are not — a terminal, a background session — count.
 */
export function openConflict(
  live: Array<ClaudeProcess & { ppid?: number }> | null, sessionId: string, selfPid: number, hasTabHere = false,
): OpenConflict {
  if (live === null) return { kind: 'unknown' };
  const counts = (p: ClaudeProcess & { ppid?: number }): boolean => {
    if (p.ppid === undefined) return p.entrypoint !== 'claude-vscode';
    return p.ppid !== selfPid || !hasTabHere;
  };
  const others = live.filter(p => p.sessionId === sessionId && counts(p));
  return others.length ? { kind: 'elsewhere', processes: others } : { kind: 'none' };
}

/** "a terminal (idle)", "another VS Code window (busy)", "this window's side panel" — for the warning. */
export function describeProcess(p: ClaudeProcess & { ppid?: number }, selfPid?: number): string {
  const where = p.ppid !== undefined && p.ppid === selfPid ? "this window's Claude Code side panel"
    : p.entrypoint === 'claude-vscode' ? 'another VS Code window'
    : p.entrypoint === 'cli' ? 'a terminal'
    : p.entrypoint ? `a Claude Code process (${p.entrypoint})` : 'another Claude Code process';
  const bits = [p.status, `pid ${p.pid}`].filter(Boolean).join(', ');
  return `${where} (${bits})`;
}
