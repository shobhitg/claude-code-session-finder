export const INDEX_VERSION = 2;

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
  title: string | null;
  branches: string[];
  prLinks: number[];
  /** From message timestamps, not file mtime. */
  firstTs: number;
  lastTs: number;
  msgCount: number;
  mtimeMs: number;
  size: number;
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
