import type { ProseMsg, SessionMeta, Role } from './types.js';
import type { SourceFile } from './discover.js';

export type BareProse = Omit<ProseMsg, 's'>;
export type BareMeta = Omit<SessionMeta, 'cwdExists'>;

interface Part { type?: string; text?: string }
interface Line {
  type?: string; cwd?: string; gitBranch?: string; timestamp?: string;
  isSidechain?: boolean; aiTitle?: string; prNumber?: number;
  message?: { content?: string | Part[] };
}

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
  const branches = new Set<string>();
  const prLinks = new Set<number>();
  let cwd: string | null = null;
  let title: string | null = null;
  let firstTs = 0, lastTs = 0, msgCount = 0;

  for (const raw of text.split('\n')) {
    const d = parse(raw);
    if (!d) continue;

    if (typeof d.cwd === 'string' && d.cwd) cwd = d.cwd;            // LAST wins (F6)
    if (typeof d.gitBranch === 'string' && d.gitBranch) branches.add(d.gitBranch);

    const ts = d.timestamp ? Date.parse(d.timestamp) : NaN;
    if (!Number.isNaN(ts)) {
      if (!firstTs || ts < firstTs) firstTs = ts;
      if (ts > lastTs) lastTs = ts;
    }
    const t = Number.isNaN(ts) ? 0 : ts;

    if (d.type === 'ai-title' && d.aiTitle) { title = d.aiTitle; prose.push({ r: 't', t, x: d.aiTitle }); continue; }
    if (d.type === 'pr-link' && typeof d.prNumber === 'number') { prLinks.add(d.prNumber); continue; }

    let role: Role | null = null;
    if (d.type === 'user') role = d.isSidechain ? 'sub' : 'u';
    else if (d.type === 'assistant') role = d.isSidechain ? 'sub' : 'a';
    if (!role) continue;

    for (const x of textParts(d.message?.content)) { prose.push({ r: role, t, x }); msgCount++; }
  }

  return {
    meta: {
      sessionId: file.sessionId, file: file.path, projectDir: file.projectDir,
      cwd, title, branches: [...branches], prLinks: [...prLinks],
      firstTs, lastTs, msgCount, mtimeMs: file.mtimeMs, size: file.size,
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
