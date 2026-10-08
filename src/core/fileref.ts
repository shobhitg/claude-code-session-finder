/**
 * Where a file name in a transcript is on disk (D20). Pure: this lists the places to look, in order, and says
 * why each one; the host stats them and takes the first that exists.
 *
 * Transcripts name files three ways (author's corpus, 2026-10-08: ~16k absolute paths in tool inputs, ~1.3k
 * relative ones in Claude's replies): absolute, relative to the folder the agent was in (often a worktree), or
 * relative to the repository root (a reply's links, written for the workspace). And worktrees come and go: a
 * path inside one that has since been removed is most usefully the same file in the main checkout.
 */

export type Via = 'absolute' | 'cwd' | 'ancestor' | 'session' | 'main-checkout';
export interface Candidate { path: string; via: Via; why: string }

/** `/repo/.worktrees/a/b/src/x.ts` → the repository root and what follows the worktree marker. */
const WORKTREE = /^(.*?)\/(\.claude\/worktrees|\.worktrees)\/(.+)$/;

/** `a/./b/../c` → `a/c`; keeps a leading slash; never climbs above the root. */
export function normalize(p: string): string {
  const abs = p.startsWith('/');
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (out.length) out.pop(); continue; }
    out.push(seg);
  }
  return (abs ? '/' : '') + out.join('/');
}
const join = (a: string, b: string): string => normalize(`${a}/${b}`);
const parentsOf = (dir: string, levels: number): string[] => {
  const out: string[] = []; let d = normalize(dir);
  for (let i = 0; i < levels && d.lastIndexOf('/') > 0; i++) { d = d.slice(0, d.lastIndexOf('/')); out.push(d); }
  return out;
};
const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
/** The worktree a folder sits in, as its marker path shows it ("webhook-rate-limit", "shobhit/selection-ask"). */
export function worktreeOf(dir: string | undefined): string | undefined {
  const m = dir ? WORKTREE.exec(dir) : null;
  return m ? m[3]!.split('/').slice(0, 2).join('/') : undefined;
}

/**
 * The places to look for `raw`, best first. `cwd` is the folder the transcript recorded around the mention,
 * `sessionCwd` the folder the session began in, `home` expands a leading `~/`.
 */
export function candidates(raw: string, ctx: { cwd?: string; sessionCwd?: string; home?: string }): Candidate[] {
  const out: Candidate[] = []; const seen = new Set<string>();
  const add = (path: string, via: Via, why: string): void => { const p = normalize(path); if (!seen.has(p)) { seen.add(p); out.push({ path: p, via, why }); } };
  let p = raw.trim();
  if (p.startsWith('~/') && ctx.home) p = join(ctx.home, p.slice(2));

  if (p.startsWith('/')) {
    add(p, 'absolute', worktreeOf(p) ? `In the worktree ${worktreeOf(p)}.` : 'Absolute path.');
    const m = WORKTREE.exec(p);
    if (m) {
      // the worktree's folder name may have one or more segments ("x", "shobhit/x"): try each split
      const rest = m[3]!.split('/');
      for (let k = 1; k <= Math.min(3, rest.length - 1); k++) {
        const name = rest.slice(0, k).join('/');
        add(join(m[1]!, rest.slice(k).join('/')), 'main-checkout', `The worktree ${name} is gone; this is the same path in the main checkout, which may have changed since.`);
      }
    }
    return out;
  }

  const rel = p.replace(/^\.\//, '');
  if (ctx.cwd) {
    const wt = worktreeOf(ctx.cwd);
    add(join(ctx.cwd, rel), 'cwd', wt ? `Relative path, found in the worktree ${wt}, where it was working.` : 'Relative path, found in the folder it was working in.');
    for (const a of parentsOf(ctx.cwd, 4)) add(join(a, rel), 'ancestor', `Relative path, found under ${base(a) || a}.`);
    // a worktree that is gone: its main checkout holds the same relative paths
    const m = WORKTREE.exec(ctx.cwd);
    if (m) add(join(m[1]!, rel), 'main-checkout', `Relative to the worktree ${worktreeOf(ctx.cwd)}, which is gone; this is the same path in the main checkout.`);
  }
  if (ctx.sessionCwd && ctx.sessionCwd !== ctx.cwd) {
    add(join(ctx.sessionCwd, rel), 'session', 'Relative path, found in the folder the session began in.');
    for (const a of parentsOf(ctx.sessionCwd, 4)) add(join(a, rel), 'ancestor', `Relative path, found under ${base(a) || a}.`);
  }
  return out;
}

const EXT_KIND: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript (TSX)', js: 'JavaScript', jsx: 'JavaScript (JSX)', mjs: 'JavaScript module', cjs: 'JavaScript',
  json: 'JSON', jsonl: 'JSON Lines', md: 'Markdown', mdx: 'MDX', py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', java: 'Java',
  kt: 'Kotlin', swift: 'Swift', c: 'C', h: 'C header', cpp: 'C++', cs: 'C#', css: 'CSS', scss: 'SCSS', html: 'HTML', vue: 'Vue',
  svelte: 'Svelte', yml: 'YAML', yaml: 'YAML', toml: 'TOML', sh: 'Shell script', sql: 'SQL', txt: 'Text', log: 'Log', csv: 'CSV',
  xml: 'XML', png: 'PNG image', jpg: 'JPEG image', jpeg: 'JPEG image', gif: 'GIF image', webp: 'WebP image', svg: 'SVG image',
  ico: 'Icon', pdf: 'PDF', lock: 'Lockfile', env: 'Environment file', ipynb: 'Jupyter notebook',
};
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon' };
const ext = (p: string): string => { const b = base(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : ''; };
/** What kind of file a name is, for its card: a label, and the image type when it can be previewed as one. */
export function fileKind(p: string): { label: string; image?: string } {
  const e = ext(p); const image = IMAGE_MIME[e];
  return { label: EXT_KIND[e] ?? (e ? `.${e} file` : 'File'), ...(image ? { image } : {}) };
}
