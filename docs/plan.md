# Claude Code Session Finder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A VS Code extension that content-searches every Claude Code session transcript on the machine and opens the matching session in one keystroke.

**Architecture:** A `vscode`-free `core/` module (discover → extract → cache → query) wrapped by thin `vscode`-aware surfaces. The MVP surface is a Quick Pick. Opening is planned by a pure function and executed by a thin adapter, so the hardest logic is unit-testable without an extension host.

**Tech Stack:** TypeScript 5.x · Node 20 · VS Code API ^1.94.0 · esbuild (bundling) · vitest (unit) · @vscode/test-electron (surface) · @vscode/vsce + ovsx (publishing)

**Spec:** `docs/design.md` — read it before starting. Findings F1–F8 in §3 each invalidate an otherwise-obvious implementation; they are the reason several tasks below look pedantic.

## Global Constraints

Every task's requirements implicitly include these. Values copied verbatim from the spec.

- **`src/core/**` MUST NOT import `vscode`.** Enforced by eslint `no-restricted-imports`. This is what makes `core/` testable and future surfaces cheap.
- **Engine:** `"vscode": "^1.94.0"`. **License:** MIT. **Publisher:** `<tbd>` (spec §14 open question).
- **`"activationEvents": []`** — commands activate lazily. Never `onStartupFinished`.
- **`"extensionDependencies": ["anthropic.claude-code"]`**
- **Every emitted `QuickPickItem` MUST set `alwaysShow: true`** (F7) — otherwise VS Code's own label filter silently drops correct content matches.
- **Always pass `prompt` as `undefined`** to `claude-vscode.editor.open` (F3) — a prompt on an already-open session triggers a confusing toast.
- **Never build a folder URI with `Uri.file()`** (F8). Always `workspaceFolders[0].uri.with({ path })` so the devcontainer/SSH authority is preserved.
- **A session's folder is the LAST `cwd` recorded in its file** (F6), never derived from the directory name.
- **Index cache key is `(mtimeMs, size)`;** schema mismatch on `INDEX_VERSION` discards and rebuilds (0.76 s, so never be clever).
- **Config prefix is `sessionFinder.`** (e.g. `sessionFinder.defaultWindow`, default `"7d"`).
- **macOS and Linux are both first-class targets.** Never hand-build paths with `/`
  concatenation — use `node:path`. **All path equality MUST go through
  `src/core/paths.ts` (Task 7)**, never `===`. macOS returns filenames in NFD from some
  APIs and its default APFS volume is case-insensitive; Linux is NFC and case-sensitive.
  Claude Code itself does `process.platform === "darwin" ? p.normalize("NFC") : p`, and
  disagreeing with it means our folder comparisons silently differ from its own.
  Windows is explicitly **not** a target.

**Deviation from the spec, deliberate:** the spec names the cache module `core/index.ts`. That filename is resolved by Node/bundlers as the directory's barrel, which makes `import ... from './core'` ambiguous. It is named **`core/cache.ts`** throughout this plan.

---

### Task 1: Project scaffold and shared types

**Files:**
- Create: `package.json`, `tsconfig.json`, `.eslintrc.json`, `esbuild.mjs`, `vitest.config.ts`, `src/core/types.ts`
- Test: `test/types.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `SessionMeta`, `ProseMsg`, `Role`, `SearchIndex`, `INDEX_VERSION` from `src/core/types.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/types.test.ts
import { describe, it, expect } from 'vitest';
import { INDEX_VERSION } from '../src/core/types.js';
import type { SessionMeta, ProseMsg, SearchIndex } from '../src/core/types.js';

describe('types', () => {
  it('exports a numeric index version', () => {
    expect(typeof INDEX_VERSION).toBe('number');
    expect(INDEX_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('a SearchIndex is structurally assignable', () => {
    const meta: SessionMeta = {
      sessionId: 'a', file: '/a.jsonl', projectDir: '-a',
      cwd: '/a', cwdExists: true, title: null, branches: [], prLinks: [],
      firstTs: 1, lastTs: 2, msgCount: 0, mtimeMs: 1, size: 1,
    };
    const prose: ProseMsg = { s: 0, r: 'u', t: 1, x: 'hello' };
    const idx: SearchIndex = { v: INDEX_VERSION, builtAt: 0, sessions: [meta], prose: [prose] };
    expect(idx.sessions[0].sessionId).toBe('a');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/types.test.ts`
Expected: FAIL — cannot resolve `../src/core/types.js`

- [ ] **Step 3: Write the scaffold and types**

```jsonc
// package.json
{
  "name": "claude-code-session-finder",
  "displayName": "Claude Code Session Finder",
  "description": "Search the contents of your Claude Code sessions and jump straight to one.",
  "version": "0.0.1",
  "license": "MIT",
  "publisher": "<tbd>",
  "repository": { "type": "git", "url": "https://github.com/shobhitg/claude-code-session-finder" },
  "engines": { "vscode": "^1.94.0" },
  "categories": ["Other"],
  "main": "./dist/extension.js",
  "extensionDependencies": ["anthropic.claude-code"],
  "activationEvents": [],
  "contributes": {
    "commands": [
      { "command": "sessionFinder.search", "title": "Claude: Search Sessions" }
    ],
    "configuration": {
      "title": "Claude Code Session Finder",
      "properties": {
        "sessionFinder.defaultWindow": {
          "type": "string",
          "default": "7d",
          "description": "Default recency window for searches. e.g. 7d, 30d, all"
        }
      }
    }
  },
  "scripts": {
    "build": "node esbuild.mjs",
    "test": "vitest run",
    "lint": "eslint src test --ext .ts",
    "package": "vsce package"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/vscode": "^1.94.0",
    "@typescript-eslint/eslint-plugin": "^7.0.0",
    "@typescript-eslint/parser": "^7.0.0",
    "esbuild": "^0.21.0",
    "eslint": "^8.57.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  }
}
```

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "outDir": "out",
    "rootDir": ".",
    "skipLibCheck": true
  },
  "include": ["src", "test"]
}
```

```jsonc
// .eslintrc.json  — this is the core/ boundary enforcement
{
  "parser": "@typescript-eslint/parser",
  "plugins": ["@typescript-eslint"],
  "extends": ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  "overrides": [
    {
      "files": ["src/core/**/*.ts"],
      "rules": {
        "no-restricted-imports": ["error", {
          "paths": [{
            "name": "vscode",
            "message": "src/core must stay vscode-free so it is testable without an extension host."
          }]
        }]
      }
    }
  ]
}
```

```js
// esbuild.mjs
import { build } from 'esbuild';
await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  minify: process.argv.includes('--minify'),
  sourcemap: true,
});
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
```

```ts
// src/core/types.ts
export const INDEX_VERSION = 1;

/** 'u' your prompt · 'a' Claude prose · 't' session title · 'sub' subagent prose */
export type Role = 'u' | 'a' | 't' | 'sub';

export interface SessionMeta {
  sessionId: string;
  file: string;
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
```

- [ ] **Step 4: Install, run tests and lint**

Run: `npm install && npx vitest run test/types.test.ts && npm run lint`
Expected: test PASS, lint clean

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json .eslintrc.json esbuild.mjs vitest.config.ts src/core/types.ts test/types.test.ts
git commit -m "feat: scaffold extension with vscode-free core boundary"
```

---

### Task 2: Redacted fixtures from real transcripts

Spec §11 requires fixtures derived from real sessions — every surprise in the design came from real data and none would appear in invented fixtures.

**Files:**
- Create: `scripts/make-fixtures.mjs`, `test/fixtures/README.md`
- Create (generated, committed): `test/fixtures/*.jsonl`

**Interfaces:**
- Consumes: `SessionMeta` shape from Task 1 (only conceptually)
- Produces: fixture files used by Tasks 4–8. Three are named and relied on by later tasks:
  - `test/fixtures/simple.jsonl` — one session, one cwd, a title, a pr-link
  - `test/fixtures/moved-cwd.jsonl` — dir name disagrees with cwd; cwd changes mid-file
  - `test/fixtures/subagent-parent.jsonl` + `test/fixtures/subagent-child.jsonl`

- [ ] **Step 1: Write the redaction script**

> **This step's original code block has been removed.** It carried a `scrub()` whose
> allow-list was the *inverted* policy — keep-listed keys survived and everything else
> was assumed safe — and implementing it proved that it leaks: verbatim user prompts,
> session titles and internal file paths all passed straight through. It sat here in the
> file that reads as the authoritative plan, ready to be copied. The shipped policy is
> the opposite, **scrub by default**, for keys and for every kind of value:
>
> - a short `STRUCTURAL` allow-list of keys keeps its *string* values verbatim (the
>   tests assert on `cwd`, `gitBranch`, `timestamp`, …); every other string becomes
>   deterministic lorem filler;
> - numbers are replaced with `0` (a PR number identifies a private repo; diff line
>   ranges fingerprint real files), except a `NUMERIC_STRUCTURAL` list whose values must
>   stay a *number* and get a placeholder instead of the real one;
> - booleans are replaced with `false` except the one flag extraction reads;
> - object keys that are data rather than schema (a real path used as a map key) become
>   numbered `redactedKeyN` placeholders;
> - `prUrl` is dropped, image payloads are stubbed.
>
> **`scripts/make-fixtures.mjs` is the source of truth**; `scripts/check-fixtures.mjs`
> is its adversarial twin and must be kept in sync with it, and
> `test/fixtures/README.md` documents the policy for reviewers.

- [ ] **Step 2: Generate the three fixtures**

```bash
mkdir -p test/fixtures
P=~/.claude/projects
# Pick sources by SHAPE, never by hard-coded project-dir name — those name real
# private projects and must not appear in this repo. Choose: (a) any session that
# contains a pr-link record, (b) a session whose recorded cwd differs from its
# project-dir name (the F6 case), and (c) a subagent transcript plus its parent.
SIMPLE=$(grep -l '"type":"pr-link"' $P/*/*.jsonl | head -1)
MOVED=$(for f in $P/*/*.jsonl; do [ "$(grep -o '"cwd":"[^"]*"' "$f" | sort -u | wc -l)" -ge 2 ] && echo "$f" && break; done)
CHILD=$(find $P -path '*/subagents/*.jsonl' | head -1)
PARENT="$(echo "$CHILD" | sed -E 's|/subagents/.*||').jsonl"
node scripts/make-fixtures.mjs "$SIMPLE" test/fixtures/simple.jsonl 80
node scripts/make-fixtures.mjs "$MOVED"  test/fixtures/moved-cwd.jsonl 60
node scripts/make-fixtures.mjs "$CHILD"  test/fixtures/subagent-child.jsonl 50
node scripts/make-fixtures.mjs "$PARENT" test/fixtures/subagent-parent.jsonl 50
# pick a session whose dir name disagrees with its cwd (spec §3 F6 measured 47% do)

```

- [ ] **Step 3: Hand-verify the fixtures are actually redacted**

Run: `grep -c 'base64' test/fixtures/*.jsonl; head -2 test/fixtures/simple.jsonl`
Expected: no long base64 blobs; prose replaced with lorem tokens; `cwd`, `type`, `timestamp` intact.

**This step is a human gate.** Do not commit fixtures you have not eyeballed — they are derived from real conversations and this repo is public.

- [ ] **Step 4: Write the fixtures README**

```markdown
<!-- test/fixtures/README.md -->
# Fixtures

Generated by `scripts/make-fixtures.mjs` from real `~/.claude/projects` transcripts,
then **redacted**: all prose is replaced with deterministic filler and every base64
image payload is stripped. Structure (`type`, `cwd`, `gitBranch`, `timestamp`,
`isSidechain`, `aiTitle`, `prNumber`) is preserved, because structure is what the
tests assert on.

| File | Why it exists |
|---|---|
| `simple.jsonl` | happy path: one cwd, a title, a pr-link |
| `moved-cwd.jsonl` | dir name disagrees with cwd, and cwd changes mid-file (spec F6) |
| `subagent-parent.jsonl` / `subagent-child.jsonl` | subagent prose attributed to parent |

Regenerate with the script; never hand-edit. Never add an unredacted transcript.
```

- [ ] **Step 5: Commit**

```bash
git add scripts/make-fixtures.mjs test/fixtures/
git commit -m "test: redacted fixtures derived from real transcripts"
```

---

### Task 3: Discovery of session and subagent files

**Files:**
- Create: `src/core/discover.ts`
- Test: `test/discover.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  ```ts
  export interface SourceFile {
    path: string; sessionId: string; projectDir: string;
    kind: 'session' | 'subagent'; mtimeMs: number; size: number;
  }
  export function defaultRoot(): string;
  export async function discover(root?: string): Promise<SourceFile[]>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// test/discover.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discover } from '../src/core/discover.js';

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ccsf-'));
  mkdirSync(join(root, '-w-proj'), { recursive: true });
  writeFileSync(join(root, '-w-proj', 'aaaa-1111.jsonl'), '{}\n');
  mkdirSync(join(root, '-w-proj', 'aaaa-1111', 'subagents'), { recursive: true });
  writeFileSync(join(root, '-w-proj', 'aaaa-1111', 'subagents', 'agent-x.jsonl'), '{}\n');
  // must be ignored: not a .jsonl, and a tool-results sidecar
  mkdirSync(join(root, '-w-proj', 'aaaa-1111', 'tool-results'), { recursive: true });
  writeFileSync(join(root, '-w-proj', 'aaaa-1111', 'tool-results', 'x.txt'), 'noise');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('discover', () => {
  it('finds top-level sessions and subagent transcripts, ignores sidecars', async () => {
    const found = await discover(root);
    expect(found).toHaveLength(2);
    const session = found.find(f => f.kind === 'session')!;
    const sub = found.find(f => f.kind === 'subagent')!;
    expect(session.sessionId).toBe('aaaa-1111');
    expect(session.projectDir).toBe('-w-proj');
    expect(sub.sessionId).toBe('aaaa-1111');   // attributed to the PARENT (spec §6)
    expect(sub.size).toBeGreaterThan(0);
  });

  it('returns an empty list when the root does not exist', async () => {
    expect(await discover(join(root, 'nope'))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/discover.test.ts`
Expected: FAIL — cannot resolve `../src/core/discover.js`

- [ ] **Step 3: Write the implementation**

```ts
// src/core/discover.ts
import { readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

export interface SourceFile {
  path: string;
  /** For subagents this is the PARENT session id, so matches attribute correctly. */
  sessionId: string;
  projectDir: string;
  kind: 'session' | 'subagent';
  mtimeMs: number;
  size: number;
}

export function defaultRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

async function safeReaddir(dir: string): Promise<string[]> {
  try { return await readdir(dir); } catch { return []; }
}

export async function discover(root: string = defaultRoot()): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  for (const projectDir of await safeReaddir(root)) {
    const projectPath = join(root, projectDir);
    for (const entry of await safeReaddir(projectPath)) {
      if (entry.endsWith('.jsonl')) {
        const path = join(projectPath, entry);
        const s = await stat(path).catch(() => null);
        if (!s?.isFile()) continue;
        out.push({ path, sessionId: basename(entry, '.jsonl'), projectDir,
                   kind: 'session', mtimeMs: s.mtimeMs, size: s.size });
        continue;
      }
      // <sessionId>/subagents/*.jsonl — everything else in the sidecar dir is ignored
      const subDir = join(projectPath, entry, 'subagents');
      for (const agent of await safeReaddir(subDir)) {
        if (!agent.endsWith('.jsonl')) continue;
        const path = join(subDir, agent);
        const s = await stat(path).catch(() => null);
        if (!s?.isFile()) continue;
        out.push({ path, sessionId: entry, projectDir, kind: 'subagent',
                   mtimeMs: s.mtimeMs, size: s.size });
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/discover.test.ts && npm run lint`
Expected: 2 PASS, lint clean

- [ ] **Step 5: Commit**

```bash
git add src/core/discover.ts test/discover.test.ts
git commit -m "feat(core): discover session and subagent transcripts"
```

---

### Task 4: Prose extraction and session metadata

This is the task that implements F6. Read spec §3 F6 before starting.

**Files:**
- Create: `src/core/extract.ts`
- Test: `test/extract.test.ts`

**Interfaces:**
- Consumes: `SessionMeta`, `ProseMsg`, `Role` (Task 1); `SourceFile` (Task 3)
- Produces:
  ```ts
  export type BareProse = Omit<ProseMsg, 's'>;
  export type BareMeta  = Omit<SessionMeta, 'cwdExists'>;
  export function extractSession(file: SourceFile, text: string): { meta: BareMeta; prose: BareProse[] };
  export function extractSubagent(file: SourceFile, text: string): BareProse[];
  ```
  `cwdExists` is deliberately NOT set here — extraction stays free of filesystem access so it is pure and fast to test. Task 5 fills it in.

- [ ] **Step 1: Write the failing test**

```ts
// test/extract.test.ts
import { describe, it, expect } from 'vitest';
import { extractSession, extractSubagent } from '../src/core/extract.js';
import type { SourceFile } from '../src/core/discover.js';

const f = (kind: SourceFile['kind'] = 'session'): SourceFile => ({
  path: '/p/-w-a/s1.jsonl', sessionId: 's1', projectDir: '-w-a', kind, mtimeMs: 5, size: 9,
});

const line = (o: unknown) => JSON.stringify(o);

describe('extractSession', () => {
  it('pulls prose and skips images, tool results and thinking', () => {
    const text = [
      line({ type: 'user', cwd: '/a', timestamp: '2026-08-01T00:00:00Z',
             message: { content: 'find the paste bug' } }),
      line({ type: 'user', timestamp: '2026-08-01T00:00:01Z',
             message: { content: [{ type: 'tool_result', content: 'SECRET STDOUT' }] } }),
      line({ type: 'assistant', timestamp: '2026-08-01T00:00:02Z',
             message: { content: [
               { type: 'thinking', thinking: 'SECRET THOUGHT' },
               { type: 'tool_use', name: 'Bash', input: { command: 'SECRET CMD' } },
               { type: 'text', text: 'here is the fix' }] } }),
      line({ type: 'user', timestamp: '2026-08-01T00:00:03Z',
             message: { content: [{ type: 'image', source: { data: 'SECRETB64' } }] } }),
    ].join('\n');

    const { prose } = extractSession(f(), text);
    const all = prose.map(p => p.x).join(' | ');
    expect(all).toContain('find the paste bug');
    expect(all).toContain('here is the fix');
    expect(all).not.toContain('SECRET');
    expect(prose.map(p => p.r)).toEqual(['u', 'a']);
  });

  it('takes the LAST cwd, not the first, and not the directory name (F6)', () => {
    const text = [
      line({ type: 'user', cwd: '/first', timestamp: '2026-08-01T00:00:00Z', message: { content: 'a' } }),
      line({ type: 'user', cwd: '/second', timestamp: '2026-08-01T00:00:01Z', message: { content: 'b' } }),
    ].join('\n');
    expect(extractSession(f(), text).meta.cwd).toBe('/second');
  });

  it('captures title, pr links, branches and real timestamps', () => {
    const text = [
      line({ type: 'user', gitBranch: 'main', timestamp: '2026-08-01T00:00:00Z', message: { content: 'a' } }),
      line({ type: 'pr-link', prNumber: 1234, timestamp: '2026-08-01T00:00:01Z' }),
      line({ type: 'user', gitBranch: 'feat/x', timestamp: '2026-08-02T00:00:00Z', message: { content: 'b' } }),
      line({ type: 'ai-title', aiTitle: 'Paste-image handling in the composer' }),
    ].join('\n');
    const { meta, prose } = extractSession(f(), text);
    expect(meta.title).toBe('Paste-image handling in the composer');
    expect(meta.prLinks).toEqual([1234]);
    expect(meta.branches.sort()).toEqual(['feat/x', 'main']);
    expect(meta.firstTs).toBe(Date.parse('2026-08-01T00:00:00Z'));
    expect(meta.lastTs).toBe(Date.parse('2026-08-02T00:00:00Z'));
    expect(prose.some(p => p.r === 't' && p.x.includes('Paste-image handling'))).toBe(true);
  });

  it('marks sidechain turns as subagent prose', () => {
    const text = line({ type: 'user', isSidechain: true, timestamp: '2026-08-01T00:00:00Z',
                        message: { content: 'delegated work' } });
    expect(extractSession(f(), text).prose[0]!.r).toBe('sub');
  });

  it('survives a truncated final line', () => {
    const text = line({ type: 'user', timestamp: '2026-08-01T00:00:00Z', message: { content: 'a' } })
      + '\n{"type":"user","mess';
    expect(() => extractSession(f(), text)).not.toThrow();
    expect(extractSession(f(), text).prose).toHaveLength(1);
  });
});

describe('extractSubagent', () => {
  it('returns prose tagged sub', () => {
    const text = line({ type: 'assistant', timestamp: '2026-08-01T00:00:00Z',
                        message: { content: [{ type: 'text', text: 'agent report' }] } });
    const prose = extractSubagent(f('subagent'), text);
    expect(prose).toHaveLength(1);
    expect(prose[0]!.r).toBe('sub');
    expect(prose[0]!.x).toBe('agent report');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/extract.test.ts`
Expected: FAIL — cannot resolve `../src/core/extract.js`

- [ ] **Step 3: Write the implementation**

```ts
// src/core/extract.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/extract.test.ts && npm run lint`
Expected: 6 PASS, lint clean

- [ ] **Step 5: Add the fixture-backed regression test**

```ts
// append to test/extract.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('extract against redacted real fixtures', () => {
  it('resolves cwd from content even when the directory name disagrees (F6)', () => {
    const path = join(__dirname, 'fixtures', 'moved-cwd.jsonl');
    const src: SourceFile = { path, sessionId: 'fixture', kind: 'session',
      projectDir: '-dir-proj--claude-wt-feature-branch', mtimeMs: 1, size: 1 };
    const { meta } = extractSession(src, readFileSync(path, 'utf8'));
    expect(meta.cwd).toBeTruthy();
    // the whole point: the resolved cwd is NOT reconstructible from projectDir
    expect(meta.cwd).not.toBe(src.projectDir);
    expect(meta.cwd!.startsWith('/')).toBe(true);
  });
});
```

- [ ] **Step 6: Run and commit**

Run: `npx vitest run test/extract.test.ts`
Expected: 7 PASS

```bash
git add src/core/extract.ts test/extract.test.ts
git commit -m "feat(core): extract prose and metadata, resolving cwd from content (F6)"
```

---

### Task 5: Index cache with mtime refresh

**Files:**
- Create: `src/core/cache.ts`
- Test: `test/cache.test.ts`

**Interfaces:**
- Consumes: `SearchIndex`, `INDEX_VERSION` (Task 1); `discover`, `SourceFile` (Task 3); `extractSession`, `extractSubagent` (Task 4)
- Produces:
  ```ts
  export interface RefreshStats { scanned: number; reExtracted: number; ms: number }
  export async function refreshIndex(opts: {
    root?: string; cacheFile: string; existsSync?: (p: string) => boolean;
  }): Promise<{ index: SearchIndex; stats: RefreshStats }>;
  ```
  `existsSync` is injectable so `cwdExists` can be tested without real folders.

- [ ] **Step 1: Write the failing test**

```ts
// test/cache.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { refreshIndex } from '../src/core/cache.js';
import { INDEX_VERSION } from '../src/core/types.js';

let root: string, cacheFile: string;
const sessionLine = (cwd: string, text: string) =>
  JSON.stringify({ type: 'user', cwd, timestamp: '2026-08-01T00:00:00Z', message: { content: text } });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ccsf-cache-'));
  cacheFile = join(root, 'index.json');
  mkdirSync(join(root, 'projects', '-w-a'), { recursive: true });
  writeFileSync(join(root, 'projects', '-w-a', 's1.jsonl'), sessionLine('/w/a', 'hello world') + '\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const opts = () => ({ root: join(root, 'projects'), cacheFile, existsSync: (p: string) => p === '/w/a' });

describe('refreshIndex', () => {
  it('builds an index on first run', async () => {
    const { index, stats } = await refreshIndex(opts());
    expect(index.v).toBe(INDEX_VERSION);
    expect(index.sessions).toHaveLength(1);
    expect(index.sessions[0]!.cwdExists).toBe(true);
    expect(index.prose.some(p => p.x === 'hello world')).toBe(true);
    expect(stats.reExtracted).toBe(1);
  });

  it('skips unchanged files on the second run', async () => {
    await refreshIndex(opts());
    const { stats } = await refreshIndex(opts());
    expect(stats.scanned).toBe(1);
    expect(stats.reExtracted).toBe(0);
  });

  it('re-extracts a file whose mtime changed', async () => {
    await refreshIndex(opts());
    const f = join(root, 'projects', '-w-a', 's1.jsonl');
    writeFileSync(f, sessionLine('/w/a', 'hello world') + '\n' + sessionLine('/w/a', 'second turn') + '\n');
    const future = new Date(Date.now() + 60_000);
    utimesSync(f, future, future);
    const { index, stats } = await refreshIndex(opts());
    expect(stats.reExtracted).toBe(1);
    expect(index.prose.some(p => p.x === 'second turn')).toBe(true);
  });

  it('discards a cache whose version does not match', async () => {
    writeFileSync(cacheFile, JSON.stringify({ v: 999, builtAt: 0, sessions: [], prose: [] }));
    const { index, stats } = await refreshIndex(opts());
    expect(index.v).toBe(INDEX_VERSION);
    expect(stats.reExtracted).toBe(1);
  });

  it('marks a session whose cwd no longer exists', async () => {
    mkdirSync(join(root, 'projects', '-w-b'), { recursive: true });
    writeFileSync(join(root, 'projects', '-w-b', 's2.jsonl'), sessionLine('/gone', 'x') + '\n');
    const { index } = await refreshIndex(opts());
    expect(index.sessions.find(s => s.sessionId === 's2')!.cwdExists).toBe(false);
  });

  it('prose from a subagent points at its parent session', async () => {
    mkdirSync(join(root, 'projects', '-w-a', 's1', 'subagents'), { recursive: true });
    writeFileSync(join(root, 'projects', '-w-a', 's1', 'subagents', 'agent-1.jsonl'),
      JSON.stringify({ type: 'assistant', timestamp: '2026-08-01T00:00:00Z',
                       message: { content: [{ type: 'text', text: 'agent finding' }] } }) + '\n');
    const { index } = await refreshIndex(opts());
    const hit = index.prose.find(p => p.x === 'agent finding')!;
    expect(hit.r).toBe('sub');
    expect(index.sessions[hit.s]!.sessionId).toBe('s1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cache.test.ts`
Expected: FAIL — cannot resolve `../src/core/cache.js`

- [ ] **Step 3: Write the implementation**

```ts
// src/core/cache.ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync as nodeExistsSync } from 'node:fs';
import { dirname } from 'node:path';
import { INDEX_VERSION, type SearchIndex, type SessionMeta, type ProseMsg } from './types.js';
import { discover, defaultRoot, type SourceFile } from './discover.js';
import { extractSession, extractSubagent, type BareProse } from './extract.js';

export interface RefreshStats { scanned: number; reExtracted: number; ms: number }

interface CachedFile { key: string; meta?: SessionMeta; prose: BareProse[] }
interface CacheShape extends SearchIndex { files?: Record<string, CachedFile> }

const keyOf = (f: SourceFile) => `${f.mtimeMs}:${f.size}`;

async function loadCache(cacheFile: string): Promise<Record<string, CachedFile>> {
  try {
    const parsed = JSON.parse(await readFile(cacheFile, 'utf8')) as CacheShape;
    if (parsed.v !== INDEX_VERSION || !parsed.files) return {};
    return parsed.files;
  } catch { return {}; }
}

export async function refreshIndex(opts: {
  root?: string; cacheFile: string; existsSync?: (p: string) => boolean;
}): Promise<{ index: SearchIndex; stats: RefreshStats }> {
  const started = Date.now();
  const exists = opts.existsSync ?? nodeExistsSync;
  const files = await discover(opts.root ?? defaultRoot());
  const cached = await loadCache(opts.cacheFile);
  const next: Record<string, CachedFile> = {};
  let reExtracted = 0;

  for (const f of files) {
    const key = keyOf(f);
    const hit = cached[f.path];
    if (hit && hit.key === key) { next[f.path] = hit; continue; }
    reExtracted++;
    const text = await readFile(f.path, 'utf8').catch(() => '');
    next[f.path] = f.kind === 'session'
      ? (() => { const { meta, prose } = extractSession(f, text);
                 return { key, meta: { ...meta, cwdExists: !!meta.cwd && exists(meta.cwd) }, prose }; })()
      : { key, prose: extractSubagent(f, text) };
  }

  // Assemble: sessions first so subagent prose can point at a parent index.
  const sessions: SessionMeta[] = [];
  const bySessionId = new Map<string, number>();
  for (const entry of Object.values(next)) {
    if (!entry.meta) continue;
    bySessionId.set(entry.meta.sessionId, sessions.length);
    sessions.push(entry.meta);
  }
  const prose: ProseMsg[] = [];
  for (const [path, entry] of Object.entries(next)) {
    const sessionId = entry.meta?.sessionId ?? files.find(f => f.path === path)?.sessionId;
    const s = sessionId !== undefined ? bySessionId.get(sessionId) : undefined;
    if (s === undefined) continue;                 // orphan subagent — parent file is gone
    for (const p of entry.prose) prose.push({ ...p, s });
  }

  const index: SearchIndex = { v: INDEX_VERSION, builtAt: Date.now(), sessions, prose };
  await mkdir(dirname(opts.cacheFile), { recursive: true }).catch(() => {});
  await writeFile(opts.cacheFile, JSON.stringify({ ...index, files: next })).catch(() => {});
  return { index, stats: { scanned: files.length, reExtracted, ms: Date.now() - started } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cache.test.ts && npm run lint`
Expected: 6 PASS, lint clean

- [ ] **Step 5: Commit**

```bash
git add src/core/cache.ts test/cache.test.ts
git commit -m "feat(core): persistent index with mtime-based incremental refresh"
```

---

### Task 6: Query parsing, matching and ranking

**Files:**
- Create: `src/core/query.ts`
- Test: `test/query.test.ts`

**Interfaces:**
- Consumes: `SearchIndex`, `SessionMeta`, `Role` (Task 1)
- Produces:
  ```ts
  export interface ParsedQuery {
    terms: string[]; phrase: string | null; pr: number | null;
    sinceMs: number | null; deep: boolean; raw: string;
  }
  export function parseQuery(input: string, defaultWindow: string, now: number): ParsedQuery;
  export interface SessionHit {
    session: SessionMeta; score: number; matchCount: number;
    best: { text: string; role: Role; index: number } | null;
  }
  export function search(index: SearchIndex, q: ParsedQuery, now: number): SessionHit[];
  export function snippet(text: string, at: number, pad?: number): string;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// test/query.test.ts
import { describe, it, expect } from 'vitest';
import { parseQuery, search, snippet } from '../src/core/query.js';
import { INDEX_VERSION, type SearchIndex, type SessionMeta } from '../src/core/types.js';

const NOW = Date.parse('2026-08-24T00:00:00Z');
const DAY = 86_400_000;

const meta = (id: string, over: Partial<SessionMeta> = {}): SessionMeta => ({
  sessionId: id, file: `/${id}.jsonl`, projectDir: '-w-a', cwd: '/w/a', cwdExists: true,
  title: null, branches: [], prLinks: [], firstTs: NOW - DAY, lastTs: NOW - DAY,
  msgCount: 1, mtimeMs: 1, size: 1, ...over,
});

describe('parseQuery', () => {
  it('splits bare terms and lowercases them', () => {
    const q = parseQuery('Paste Image', '7d', NOW);
    expect(q.terms).toEqual(['paste', 'image']);
    expect(q.phrase).toBeNull();
    expect(q.sinceMs).toBe(NOW - 7 * DAY);
  });
  it('extracts a quoted phrase', () => {
    expect(parseQuery('"paste image"', '7d', NOW).phrase).toBe('paste image');
  });
  it('extracts pr: and removes it from the terms', () => {
    const q = parseQuery('pr:1234', '7d', NOW);
    expect(q.pr).toBe(1234);
    expect(q.terms).toEqual([]);
  });
  it('honours since: overrides including all', () => {
    expect(parseQuery('x since:30d', '7d', NOW).sinceMs).toBe(NOW - 30 * DAY);
    expect(parseQuery('x since:all', '7d', NOW).sinceMs).toBeNull();
    expect(parseQuery('x', 'all', NOW).sinceMs).toBeNull();
  });
  it('detects the ! deep-search prefix', () => {
    const q = parseQuery('!npm run build', '7d', NOW);
    expect(q.deep).toBe(true);
    expect(q.terms).toEqual(['npm', 'run', 'build']);
  });
});

describe('search', () => {
  const index: SearchIndex = {
    v: INDEX_VERSION, builtAt: NOW,
    sessions: [meta('s1'), meta('s2'), meta('s3', { prLinks: [1234] }),
               meta('s4', { title: 'Paste image handling' })],
    prose: [
      { s: 0, r: 'u', t: NOW - DAY, x: 'the paste image bug is annoying' },
      { s: 1, r: 'a', t: NOW - DAY, x: 'you can paste an image into the composer' },
      { s: 2, r: 'a', t: NOW - DAY, x: 'unrelated prose' },
      { s: 3, r: 't', t: NOW - DAY, x: 'Paste image handling' },
    ],
  };

  it('ranks your prompts above Claude prose for the same match', () => {
    const hits = search(index, parseQuery('paste image', '7d', NOW), NOW);
    const ids = hits.map(h => h.session.sessionId);
    expect(ids.indexOf('s1')).toBeLessThan(ids.indexOf('s2'));
  });

  it('ranks a title match at the top', () => {
    const hits = search(index, parseQuery('paste image', '7d', NOW), NOW);
    expect(hits[0]!.session.sessionId).toBe('s4');
  });

  it('pr: short-circuits to the owning session', () => {
    const hits = search(index, parseQuery('pr:1234', '7d', NOW), NOW);
    expect(hits[0]!.session.sessionId).toBe('s3');
  });

  it('an exact phrase outranks scattered terms', () => {
    const phrase = search(index, parseQuery('"paste image"', '7d', NOW), NOW);
    expect(phrase.map(h => h.session.sessionId)).toContain('s1');
    expect(phrase.map(h => h.session.sessionId)).not.toContain('s2'); // "paste an image"
  });

  it('excludes sessions outside the recency window', () => {
    const old: SearchIndex = { ...index,
      sessions: [meta('old', { lastTs: NOW - 40 * DAY })],
      prose: [{ s: 0, r: 'u', t: NOW - 40 * DAY, x: 'paste image' }] };
    expect(search(old, parseQuery('paste image', '7d', NOW), NOW)).toHaveLength(0);
    expect(search(old, parseQuery('paste image since:all', '7d', NOW), NOW)).toHaveLength(1);
  });

  it('returns one hit per session with a match count', () => {
    const many: SearchIndex = { ...index, sessions: [meta('s1')],
      prose: [{ s: 0, r: 'u', t: NOW, x: 'paste image' }, { s: 0, r: 'a', t: NOW, x: 'paste image again' }] };
    const hits = search(many, parseQuery('paste image', '7d', NOW), NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.matchCount).toBe(2);
  });
});

describe('snippet', () => {
  it('windows around the match and ellipsises', () => {
    const s = snippet('x'.repeat(100) + 'NEEDLE' + 'y'.repeat(100), 100, 10);
    expect(s).toContain('NEEDLE');
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/query.test.ts`
Expected: FAIL — cannot resolve `../src/core/query.js`

- [ ] **Step 3: Write the implementation**

```ts
// src/core/query.ts
import type { SearchIndex, SessionMeta, Role } from './types.js';

export interface ParsedQuery {
  terms: string[]; phrase: string | null; pr: number | null;
  sinceMs: number | null; deep: boolean; raw: string;
}

const DAY = 86_400_000;
const UNIT: Record<string, number> = { d: DAY, w: 7 * DAY, m: 30 * DAY };

function windowToMs(spec: string, now: number): number | null {
  const s = spec.trim().toLowerCase();
  if (!s || s === 'all') return null;
  const m = /^(\d+)([dwm])?$/.exec(s);
  if (!m) return null;
  return now - Number(m[1]) * (UNIT[m[2] ?? 'd'] ?? DAY);
}

export function parseQuery(input: string, defaultWindow: string, now: number): ParsedQuery {
  const raw = input;
  let rest = input.trim();
  const deep = rest.startsWith('!');
  if (deep) rest = rest.slice(1).trim();

  let phrase: string | null = null;
  rest = rest.replace(/"([^"]+)"/, (_, p: string) => { phrase = p.toLowerCase(); return ' '; });

  let pr: number | null = null;
  rest = rest.replace(/(?:^|\s)pr:#?(\d+)(?=\s|$)/i, (_, n: string) => { pr = Number(n); return ' '; });

  let sinceSpec: string | null = null;
  rest = rest.replace(/(?:^|\s)since:(\S+)(?=\s|$)/i, (_, v: string) => { sinceSpec = v; return ' '; });

  return {
    raw, deep, phrase, pr,
    sinceMs: windowToMs(sinceSpec ?? defaultWindow, now),
    terms: rest.toLowerCase().split(/\s+/).filter(Boolean),
  };
}

const ROLE_WEIGHT: Record<Role, number> = { t: 3.0, u: 2.0, a: 1.0, sub: 0.7 };

/** exact phrase 3.0 · all terms within a 40-char span 2.0 · all terms present 1.0 · else 0 */
function matchQuality(lower: string, q: ParsedQuery): { score: number; at: number } {
  if (q.phrase) { const at = lower.indexOf(q.phrase); return { score: at >= 0 ? 3.0 : 0, at: Math.max(at, 0) }; }
  if (!q.terms.length) return { score: 0, at: 0 };
  const positions: number[] = [];
  for (const t of q.terms) { const at = lower.indexOf(t); if (at < 0) return { score: 0, at: 0 }; positions.push(at); }
  const lo = Math.min(...positions), hi = Math.max(...positions);
  return { score: hi - lo <= 40 ? 2.0 : 1.0, at: lo };
}

const recencyBoost = (t: number, now: number) => 1 + 0.5 * Math.exp(-Math.max(0, now - t) / (14 * DAY));

export interface SessionHit {
  session: SessionMeta; score: number; matchCount: number;
  best: { text: string; role: Role; index: number } | null;
}

export function search(index: SearchIndex, q: ParsedQuery, now: number): SessionHit[] {
  const inWindow = (m: SessionMeta) => q.sinceMs === null || m.lastTs >= q.sinceMs;

  if (q.pr !== null) {
    return index.sessions
      .filter(m => m.prLinks.includes(q.pr!) && inWindow(m))
      .map(session => ({ session, score: 1000, matchCount: 1, best: null }));
  }
  if (!q.terms.length && !q.phrase) return [];

  const acc = new Map<number, { score: number; count: number; best: SessionHit['best'] }>();
  for (const p of index.prose) {
    const session = index.sessions[p.s];
    if (!session || !inWindow(session)) continue;
    const { score: quality, at } = matchQuality(p.x.toLowerCase(), q);
    if (!quality) continue;
    const score = quality * ROLE_WEIGHT[p.r] * recencyBoost(p.t, now);
    const cur = acc.get(p.s);
    if (!cur) acc.set(p.s, { score, count: 1, best: { text: p.x, role: p.r, index: at } });
    else {
      cur.count++;
      if (score > cur.score) { cur.score = score; cur.best = { text: p.x, role: p.r, index: at }; }
    }
  }

  return [...acc.entries()]
    .map(([s, v]) => ({
      session: index.sessions[s]!,
      score: v.score + 0.3 * Math.log1p(v.count),
      matchCount: v.count, best: v.best,
    }))
    .sort((a, b) => b.score - a.score || b.session.lastTs - a.session.lastTs);
}

export function snippet(text: string, at: number, pad = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const start = Math.max(0, at - pad), end = Math.min(flat.length, at + pad);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/query.test.ts && npm run lint`
Expected: 12 PASS, lint clean

- [ ] **Step 5: Commit**

```bash
git add src/core/query.ts test/query.test.ts
git commit -m "feat(core): query parsing, matching and ranking"
```

---

### Task 7: Open planning (pure)

The hardest logic in the extension, kept in `core/` so it is testable without an extension host. Read spec §9 before starting.

**Files:**
- Create: `src/core/paths.ts`, `src/core/resolve.ts`
- Test: `test/paths.test.ts`, `test/resolve.test.ts`

**Interfaces:**
- Consumes: `SessionMeta` (Task 1)
- Produces:
  ```ts
  // src/core/paths.ts — the ONE definition of path equality, shared with Task 9
  export function normalizePath(p: string, platform?: NodeJS.Platform): string;
  export function samePath(a: string, b: string, platform?: NodeJS.Platform): boolean;
  export function isInside(child: string, parent: string, platform?: NodeJS.Platform): boolean;

  export type OpenPlan =
    | { kind: 'here'; sessionId: string; note?: string }
    | { kind: 'handoff'; sessionId: string; targetCwd: string }
    | { kind: 'transcript'; file: string; reason: string };
  export function planOpen(session: SessionMeta, workspaceFolders: string[]): OpenPlan;
  ```

- [ ] **Step 1a: Write the failing path-equality test**

```ts
// test/paths.test.ts
import { describe, it, expect } from 'vitest';
import { normalizePath, samePath, isInside } from '../src/core/paths.js';

describe('paths on linux (case-sensitive, NFC)', () => {
  const L: NodeJS.Platform = 'linux';
  it('is case-sensitive', () => {
    expect(samePath('/w/Foo', '/w/foo', L)).toBe(false);
  });
  it('ignores a trailing slash', () => {
    expect(samePath('/w/a/', '/w/a', L)).toBe(true);
  });
  it('does not treat a sibling prefix as inside', () => {
    expect(isInside('/w/ab', '/w/a', L)).toBe(false);
    expect(isInside('/w/a/b', '/w/a', L)).toBe(true);
    expect(isInside('/w/a', '/w/a', L)).toBe(true);
  });
});

describe('paths on darwin (case-insensitive, NFD source)', () => {
  const D: NodeJS.Platform = 'darwin';
  it('folds case, because the default APFS volume does', () => {
    expect(samePath('/Users/Shobhit/src', '/users/shobhit/src', D)).toBe(true);
  });
  it('normalizes NFD to NFC, matching Claude Code itself', () => {
    const nfd = '/w/cafe\u0301';        // e + combining acute — what macOS may hand back
    const nfc = '/w/caf\u00e9';          // precomposed e-acute
    expect(nfd).not.toBe(nfc);
    expect(samePath(nfd, nfc, D)).toBe(true);
    expect(normalizePath(nfd, D)).toBe(normalizePath(nfc, D));
  });
  it('still respects segment boundaries', () => {
    expect(isInside('/W/AB', '/w/a', D)).toBe(false);
    expect(isInside('/W/A/B', '/w/a', D)).toBe(true);
  });
});
```

- [ ] **Step 1b: Run it to verify it fails**

Run: `npx vitest run test/paths.test.ts`
Expected: FAIL — cannot resolve `../src/core/paths.js`

- [ ] **Step 1c: Write `src/core/paths.ts`**

```ts
// src/core/paths.ts
// The single definition of path equality for this extension. Task 9's baton and
// Task 7's planner MUST both use it: if they disagree, a hand-off writes a baton
// the target window refuses to claim, and the click does nothing at all.

/**
 * macOS hands back NFD from some filesystem APIs and its default APFS volume is
 * case-insensitive. Claude Code normalizes with
 * `process.platform === 'darwin' ? p.normalize('NFC') : p`; we match that and
 * additionally fold case on darwin so two spellings of one real folder compare equal.
 * Linux is left byte-exact.
 */
export function normalizePath(p: string, platform: NodeJS.Platform = process.platform): string {
  const trimmed = p.length > 1 ? p.replace(/\/+$/, '') : p;
  return platform === 'darwin' ? trimmed.normalize('NFC').toLowerCase() : trimmed;
}

export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return normalizePath(a, platform) === normalizePath(b, platform);
}

/** True when `child` is `parent` or lives beneath it. Segment-aware: /w/ab is NOT inside /w/a. */
export function isInside(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const c = normalizePath(child, platform);
  const p = normalizePath(parent, platform);
  return c === p || c.startsWith(p.endsWith('/') ? p : p + '/');
}
```

- [ ] **Step 1d: Run it to verify it passes**

Run: `npx vitest run test/paths.test.ts`
Expected: 6 PASS

- [ ] **Step 1: Write the failing resolve test**

```ts
// test/resolve.test.ts
import { describe, it, expect } from 'vitest';
import { planOpen } from '../src/core/resolve.js';
import type { SessionMeta } from '../src/core/types.js';

const s = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  sessionId: 'sid', file: '/p/sid.jsonl', projectDir: '-w-a', cwd: '/w/a', cwdExists: true,
  title: null, branches: [], prLinks: [], firstTs: 0, lastTs: 0, msgCount: 0, mtimeMs: 0, size: 0, ...over,
});

describe('planOpen', () => {
  it('opens here when cwd is the primary folder', () => {
    expect(planOpen(s(), ['/w/a'])).toEqual({ kind: 'here', sessionId: 'sid' });
  });

  it('opens here when cwd is inside any workspace folder (multi-root, F5)', () => {
    const plan = planOpen(s({ cwd: '/w/b/python' }), ['/w/a', '/w/b']);
    expect(plan.kind).toBe('here');
    expect((plan as { note?: string }).note).toMatch(/workspace root/i);
  });

  it('hands off when cwd is outside the workspace', () => {
    expect(planOpen(s({ cwd: '/w/other' }), ['/w/a']))
      .toEqual({ kind: 'handoff', sessionId: 'sid', targetCwd: '/w/other' });
  });

  it('falls back to the transcript when the folder is gone', () => {
    const plan = planOpen(s({ cwd: '/w/gone', cwdExists: false }), ['/w/a']);
    expect(plan).toEqual({ kind: 'transcript', file: '/p/sid.jsonl', reason: 'folder missing' });
  });

  it('opens here with a note when no cwd was ever recorded', () => {
    const plan = planOpen(s({ cwd: null }), ['/w/a']);
    expect(plan.kind).toBe('here');
    expect((plan as { note?: string }).note).toMatch(/unknown folder/i);
  });

  it('does not treat /w/ab as inside /w/a', () => {
    expect(planOpen(s({ cwd: '/w/ab' }), ['/w/a']).kind).toBe('handoff');
  });

  it('opens here when there is no workspace open at all', () => {
    expect(planOpen(s(), []).kind).toBe('handoff');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/resolve.test.ts`
Expected: FAIL — cannot resolve `../src/core/resolve.js`

- [ ] **Step 3: Write the implementation**

```ts
// src/core/resolve.ts
import type { SessionMeta } from './types.js';
import { samePath, isInside } from './paths.js';

export type OpenPlan =
  | { kind: 'here'; sessionId: string; note?: string }
  | { kind: 'handoff'; sessionId: string; targetCwd: string }
  | { kind: 'transcript'; file: string; reason: string };

export function planOpen(session: SessionMeta, workspaceFolders: string[]): OpenPlan {
  const { sessionId, cwd, cwdExists, file } = session;

  if (cwd && !cwdExists) return { kind: 'transcript', file, reason: 'folder missing' };
  if (!cwd) return { kind: 'here', sessionId, note: 'unknown folder — resuming in this window' };

  const primary = workspaceFolders[0];
  if (primary && samePath(cwd, primary)) return { kind: 'here', sessionId };

  // F5: every workspace folder is passed as additionalDirectories, so a session
  // under any of them is safe to resume here; only the cwd differs.
  if (workspaceFolders.some(f => isInside(cwd, f))) {
    return { kind: 'here', sessionId, note: 'resuming at the workspace root, not the session folder' };
  }
  return { kind: 'handoff', sessionId, targetCwd: cwd };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/paths.test.ts test/resolve.test.ts && npm run lint`
Expected: 13 PASS, lint clean

- [ ] **Step 5: Commit**

```bash
git add src/core/paths.ts src/core/resolve.ts test/paths.test.ts test/resolve.test.ts
git commit -m "feat(core): cross-platform path equality and open-planning"
```

---

### Task 8: Quick Pick surface and extension entry point

**Files:**
- Create: `src/surfaces/quickpick.ts`, `src/open.ts`, `src/extension.ts`
- Modify: `package.json` (add the keybinding contribution)

**Interfaces:**
- Consumes: `refreshIndex` (Task 5); `parseQuery`, `search`, `snippet`, `SessionHit` (Task 6); `planOpen`, `OpenPlan` (Task 7)
- Produces:
  ```ts
  // src/open.ts
  export async function executePlan(plan: OpenPlan, ctx: vscode.ExtensionContext): Promise<void>;
  // src/surfaces/quickpick.ts
  export async function showSearchQuickPick(ctx: vscode.ExtensionContext): Promise<void>;
  ```

**Manual verification carries this task**; the automated surface test that spec §11 requires (proving `alwaysShow` defeats VS Code's built-in filter) is **Task 12**. Everything else here is thin glue over an already-tested core.

- [ ] **Step 1: Write the open adapter**

```ts
// src/open.ts
import * as vscode from 'vscode';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpenPlan } from './core/resolve.js';

export const BATON_TTL_MS = 60_000;
export const batonPath = (ctx: vscode.ExtensionContext) => join(ctx.globalStorageUri.fsPath, 'pending-open.json');

/** F8: never Uri.file() — derive from an existing folder URI to keep the remote authority. */
function folderUri(path: string): vscode.Uri {
  const base = vscode.workspace.workspaceFolders?.[0]?.uri;
  return base ? base.with({ path }) : vscode.Uri.file(path);
}

export async function executePlan(plan: OpenPlan, ctx: vscode.ExtensionContext): Promise<void> {
  if (plan.kind === 'transcript') {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(plan.file));
    await vscode.window.showTextDocument(doc, { preview: true });
    vscode.window.showInformationMessage(`Cannot resume this session: ${plan.reason}. Showing the transcript.`);
    return;
  }

  if (plan.kind === 'here') {
    if (plan.note) vscode.window.setStatusBarMessage(`Claude session: ${plan.note}`, 4000);
    // F3: reveal-if-open / new-tab-otherwise is Claude Code's own behaviour.
    // Pass prompt undefined, or an already-open session shows a confusing toast.
    try {
      await vscode.commands.executeCommand('claude-vscode.editor.open', plan.sessionId, undefined);
    } catch {
      vscode.window.showErrorMessage('Claude Code did not accept the session. Is the extension enabled?');
    }
    return;
  }

  // handoff
  await vscode.workspace.fs.createDirectory(ctx.globalStorageUri);
  await writeFile(batonPath(ctx), JSON.stringify({
    sessionId: plan.sessionId, targetCwd: plan.targetCwd, expiresAt: Date.now() + BATON_TTL_MS,
  }));
  await vscode.commands.executeCommand('vscode.openFolder', folderUri(plan.targetCwd), { forceNewWindow: true });
}
```

- [ ] **Step 2: Write the Quick Pick surface**

```ts
// src/surfaces/quickpick.ts
import * as vscode from 'vscode';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { refreshIndex } from '../core/cache.js';
import { parseQuery, search, snippet, type SessionHit } from '../core/query.js';
import { planOpen } from '../core/resolve.js';
import type { SearchIndex } from '../core/types.js';
import { executePlan } from '../open.js';

interface Row extends vscode.QuickPickItem { hit?: SessionHit; action?: 'all' | 'deep' }

const ago = (ts: number) => {
  const d = Math.floor((Date.now() - ts) / 86_400_000);
  return d <= 0 ? 'today' : d === 1 ? '1d ago' : `${d}d ago`;
};

function toRow(hit: SessionHit): Row {
  const m = hit.session;
  const bits = [m.projectDir.replace(/^-/, '').split('--').pop() ?? '', m.branches.at(-1) ?? '', ago(m.lastTs)];
  if (m.prLinks.length) bits.push(`PR #${m.prLinks.at(-1)}`);
  if (!m.cwdExists) bits.push('⚠ folder missing');
  return {
    label: `$(sparkle) ${m.title ?? hit.best?.text.slice(0, 60) ?? m.sessionId}`,
    description: bits.filter(Boolean).join(' · '),
    detail: hit.best ? `${snippet(hit.best.text, hit.best.index)}   (${hit.matchCount} matches)` : undefined,
    alwaysShow: true,                    // F7 — MUST be set or VS Code re-filters on label
    buttons: [
      { iconPath: new vscode.ThemeIcon('link'), tooltip: 'Copy deep link' },
      { iconPath: new vscode.ThemeIcon('folder'), tooltip: 'Reveal folder' },
    ],
    hit,
  };
}

export async function showSearchQuickPick(ctx: vscode.ExtensionContext): Promise<void> {
  const cacheFile = join(ctx.globalStorageUri.fsPath, 'index.json');
  const defaultWindow = vscode.workspace.getConfiguration('sessionFinder').get<string>('defaultWindow', '7d');

  const qp = vscode.window.createQuickPick<Row>();
  qp.placeholder = `Search Claude sessions (last ${defaultWindow}) — "phrase", pr:123, since:all, !tools`;
  qp.matchOnDescription = false;
  qp.matchOnDetail = false;
  qp.busy = true;
  qp.show();

  let index: SearchIndex;                      // reassigned when a stale row is dropped
  try {
    ({ index } = await refreshIndex({ cacheFile }));
  } catch (err) {
    qp.hide();
    vscode.window.showErrorMessage(`Could not index Claude sessions: ${String(err)}`);
    return;
  }
  qp.busy = false;

  const render = (value: string) => {
    if (!value.trim()) { qp.items = []; return; }
    const q = parseQuery(value, defaultWindow, Date.now());
    const hits = search(index, q, Date.now());
    const rows: Row[] = hits.slice(0, 50).map(toRow);
    if (hits.length <= 2 && q.sinceMs !== null) {
      rows.push({ label: `$(history) Search all time — ${index.sessions.length} sessions`,
                  alwaysShow: true, action: 'all' });
    }
    if (hits.length === 0 && !q.deep) {
      rows.push({ label: '$(search) Search tool calls & results (slower)', alwaysShow: true, action: 'deep' });
    }
    qp.items = rows;
  };

  qp.onDidChangeValue(render);                      // 6-10 ms: synchronous, no debounce needed

  qp.onDidTriggerItemButton(async e => {
    const m = (e.item as Row).hit?.session;
    if (!m) return;
    if ((e.button.tooltip ?? '').startsWith('Copy')) {
      await vscode.env.clipboard.writeText(`vscode://anthropic.claude-code/open?session=${m.sessionId}`);
      vscode.window.setStatusBarMessage('Deep link copied', 3000);
    } else if (m.cwd) {
      await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(m.cwd));
    }
  });

  qp.onDidAccept(async () => {
    const picked = qp.selectedItems[0];
    if (!picked) return;
    if (picked.action === 'all') { qp.value = `${qp.value} since:all`; render(qp.value); return; }
    if (picked.action === 'deep') { qp.value = `!${qp.value}`; render(qp.value); return; }
    if (!picked.hit) return;

    // Spec §10: the transcript may have been deleted between indexing and now.
    // Drop it from the in-memory index so the stale row cannot be picked again.
    if (!existsSync(picked.hit.session.file)) {
      const goneId = picked.hit.session.sessionId;
      index = { ...index, sessions: index.sessions.filter(m => m.sessionId !== goneId) };
      vscode.window.showWarningMessage('That session transcript no longer exists on disk.');
      render(qp.value);
      return;
    }

    qp.hide();
    const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.path);
    await executePlan(planOpen(picked.hit.session, folders), ctx);
  });

  qp.onDidHide(() => qp.dispose());
}
```

- [ ] **Step 3: Write the entry point**

```ts
// src/extension.ts
import * as vscode from 'vscode';
import { showSearchQuickPick } from './surfaces/quickpick.js';

export function activate(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('sessionFinder.search', () => showSearchQuickPick(ctx)),
  );
}

export function deactivate(): void { /* nothing to tear down */ }
```

- [ ] **Step 4: Add the keybinding contribution**

Add to `package.json` under `contributes`:

```jsonc
"keybindings": [
  { "command": "sessionFinder.search", "key": "ctrl+alt+s", "mac": "cmd+alt+s" }
]
```

- [ ] **Step 5: Build and verify manually**

Run: `npm run build && npm run lint`
Then press **F5** in VS Code to launch the Extension Development Host and check, in order:

1. `Ctrl+Alt+S` opens the Quick Pick and it is not busy for more than ~1 s on first run.
2. Typing `paste image` shows sessions whose **content** matches — **not only ones whose title matches.** If titles are the only hits, `alwaysShow` is missing somewhere (F7).
3. Enter on a same-folder session opens a Claude tab with that conversation.
4. Enter again on the same row **reveals the existing tab** rather than opening a second (F3).
5. The link button copies `vscode://anthropic.claude-code/open?session=…`; pasting it in a terminal via `code --open-url` reopens the session.
6. A nonsense query shows the `Search all time` row, and Enter on it widens the search.

- [ ] **Step 6: Commit**

```bash
git add src/extension.ts src/open.ts src/surfaces/quickpick.ts package.json
git commit -m "feat: Quick Pick search surface and session opening"
```

---

### Task 9: Cross-window hand-off

**Prerequisite — verify spec §14 open question 2 before writing code.** In the Extension Development Host, run:

```
> Developer: Reload Window          (to get a clean state)
```
then from a scratch extension or the debug console call
`vscode.commands.executeCommand('vscode.openFolder', <uri of an already-open folder>, {forceNewWindow: true})`
and observe whether VS Code focuses the existing window or opens a duplicate.
**If it duplicates, stop and re-plan this task** — the design's hand-off assumes de-duplication.

**Files:**
- Create: `src/baton.ts`
- Modify: `src/extension.ts` (claim the baton on activate), `package.json` (`activationEvents`)
- Test: `test/baton.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  ```ts
  export interface Baton { sessionId: string; targetCwd: string; expiresAt: number }
  export function claimBaton(raw: string | null, myFolder: string | undefined, now: number):
    { claim: Baton } | { discard: true } | { leave: true };
  ```
  Pure decision function so the three-way outcome is unit-tested; file IO lives in `extension.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// test/baton.test.ts
import { describe, it, expect } from 'vitest';
import { claimBaton } from '../src/baton.js';

const NOW = 1_000_000;
const raw = (o: object) => JSON.stringify(o);

describe('claimBaton', () => {
  it('claims a baton addressed to this folder', () => {
    const r = claimBaton(raw({ sessionId: 's', targetCwd: '/w/a', expiresAt: NOW + 1000 }), '/w/a', NOW);
    expect(r).toEqual({ claim: { sessionId: 's', targetCwd: '/w/a', expiresAt: NOW + 1000 } });
  });
  it('discards an expired baton', () => {
    expect(claimBaton(raw({ sessionId: 's', targetCwd: '/w/a', expiresAt: NOW - 1 }), '/w/a', NOW))
      .toEqual({ discard: true });
  });
  it('leaves a baton addressed to another folder', () => {
    expect(claimBaton(raw({ sessionId: 's', targetCwd: '/w/b', expiresAt: NOW + 1000 }), '/w/a', NOW))
      .toEqual({ leave: true });
  });
  it('discards unparseable or absent content', () => {
    expect(claimBaton('not json', '/w/a', NOW)).toEqual({ discard: true });
    expect(claimBaton(null, '/w/a', NOW)).toEqual({ discard: true });
  });
  it('leaves the baton when this window has no folder', () => {
    expect(claimBaton(raw({ sessionId: 's', targetCwd: '/w/a', expiresAt: NOW + 1000 }), undefined, NOW))
      .toEqual({ leave: true });
  });
  it('claims a baton whose folder differs only by trailing slash', () => {
    const r = claimBaton(raw({ sessionId: 's', targetCwd: '/w/a/', expiresAt: NOW + 1000 }), '/w/a', NOW);
    expect('claim' in r).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/baton.test.ts`
Expected: FAIL — cannot resolve `../src/baton.js`

- [ ] **Step 3: Write the implementation**

```ts
// src/baton.ts
import { samePath } from './core/paths.js';

export interface Baton { sessionId: string; targetCwd: string; expiresAt: number }

export function claimBaton(raw: string | null, myFolder: string | undefined, now: number):
  { claim: Baton } | { discard: true } | { leave: true } {
  if (!raw) return { discard: true };
  let b: Baton;
  try { b = JSON.parse(raw) as Baton; } catch { return { discard: true }; }
  if (typeof b?.sessionId !== 'string' || typeof b?.targetCwd !== 'string') return { discard: true };
  if (!(b.expiresAt > now)) return { discard: true };
  if (!myFolder) return { leave: true };
  // MUST use samePath, not ===. On macOS the planner may hand off to a differently
  // cased or NFD spelling of the same folder; a strict compare would silently no-op.
  return samePath(b.targetCwd, myFolder) ? { claim: b } : { leave: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/baton.test.ts && npm run lint`
Expected: 6 PASS, lint clean

- [ ] **Step 5: Wire the claim into activation**

Replace `src/extension.ts` with:

```ts
import * as vscode from 'vscode';
import { readFile, unlink } from 'node:fs/promises';
import { showSearchQuickPick } from './surfaces/quickpick.js';
import { claimBaton } from './baton.js';
import { batonPath } from './open.js';

async function tryClaimPendingOpen(ctx: vscode.ExtensionContext): Promise<void> {
  const path = batonPath(ctx);
  const raw = await readFile(path, 'utf8').catch(() => null);
  const outcome = claimBaton(raw, vscode.workspace.workspaceFolders?.[0]?.uri.path, Date.now());
  if ('leave' in outcome) return;
  await unlink(path).catch(() => {});                 // DELETE FIRST — makes the baton single-use
  if ('discard' in outcome) return;
  await vscode.commands.executeCommand('claude-vscode.editor.open', outcome.claim.sessionId, undefined);
}

export function activate(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('sessionFinder.search', () => showSearchQuickPick(ctx)),
  );
  void tryClaimPendingOpen(ctx);
}

export function deactivate(): void { /* nothing to tear down */ }
```

Set `"activationEvents": ["onStartupFinished"]` in `package.json`.

**This is a deliberate, documented exception to the Global Constraints.** A window opened by the hand-off must activate on its own to claim the baton; nothing else would trigger it. It is the only reason to depart from lazy activation, and `tryClaimPendingOpen` must stay cheap — one `readFile` that usually fails.

- [ ] **Step 6: Verify the hand-off manually**

Run: `npm run build`, then F5. In the dev host, search for a session belonging to a **different worktree** and press Enter. Expected: a window opens on that worktree and the Claude session resumes there with the correct cwd.

- [ ] **Step 7: Commit**

```bash
git add src/baton.ts src/extension.ts package.json test/baton.test.ts
git commit -m "feat: cross-window hand-off via a single-use filesystem baton"
```

---

### Task 10: Deep (tool content) fallback

**Files:**
- Create: `src/core/deep.ts`
- Test: `test/deep.test.ts`
- Modify: `src/surfaces/quickpick.ts` (route `q.deep` through it)

**Interfaces:**
- Consumes: `ParsedQuery`, `SessionHit` (Task 6); `SearchIndex` (Task 1); `discover` (Task 3)
- Produces:
  ```ts
  export async function deepSearch(index: SearchIndex, q: ParsedQuery, now: number,
                                   readFileFn?: (p: string) => Promise<string>): Promise<SessionHit[]>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// test/deep.test.ts
import { describe, it, expect } from 'vitest';
import { deepSearch } from '../src/core/deep.js';
import { parseQuery } from '../src/core/query.js';
import { INDEX_VERSION, type SearchIndex, type SessionMeta } from '../src/core/types.js';

const NOW = Date.parse('2026-08-24T00:00:00Z');
const meta = (id: string): SessionMeta => ({
  sessionId: id, file: `/${id}.jsonl`, projectDir: '-w-a', cwd: '/w/a', cwdExists: true,
  title: null, branches: [], prLinks: [], firstTs: NOW, lastTs: NOW, msgCount: 0, mtimeMs: 1, size: 1,
});

describe('deepSearch', () => {
  const index: SearchIndex = { v: INDEX_VERSION, builtAt: NOW, sessions: [meta('s1'), meta('s2')], prose: [] };
  const files: Record<string, string> = {
    '/s1.jsonl': JSON.stringify({ type: 'user', message: { content: [
      { type: 'tool_result', content: 'error TS2345 in query.ts' }] } }),
    '/s2.jsonl': JSON.stringify({ type: 'user', message: { content: [
      { type: 'tool_result', content: 'nothing relevant' }] } }),
  };
  const read = async (p: string) => files[p] ?? '';

  it('finds terms that appear only in tool content', async () => {
    const hits = await deepSearch(index, parseQuery('!TS2345', '7d', NOW), NOW, read);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.session.sessionId).toBe('s1');
  });

  it('respects the recency window', async () => {
    const old = { ...index, sessions: [{ ...meta('s1'), lastTs: NOW - 40 * 86_400_000 }] };
    expect(await deepSearch(old, parseQuery('!TS2345', '7d', NOW), NOW, read)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/deep.test.ts`
Expected: FAIL — cannot resolve `../src/core/deep.js`

- [ ] **Step 3: Write the implementation**

```ts
// src/core/deep.ts
import { readFile } from 'node:fs/promises';
import type { SearchIndex } from './types.js';
import type { ParsedQuery, SessionHit } from './query.js';
import { snippet } from './query.js';

/**
 * Live scan of raw transcript text, including tool calls and results.
 * Deliberately NOT cached (spec §7) — this keeps the persistent index at ~6 MB
 * instead of ~170 MB, at the cost of ~0.5 s on the rare path.
 */
export async function deepSearch(
  index: SearchIndex, q: ParsedQuery, now: number,
  readFileFn: (p: string) => Promise<string> = p => readFile(p, 'utf8'),
): Promise<SessionHit[]> {
  const needles = q.phrase ? [q.phrase] : q.terms;
  if (!needles.length) return [];

  const candidates = index.sessions.filter(m => q.sinceMs === null || m.lastTs >= q.sinceMs);
  const hits: SessionHit[] = [];

  await Promise.all(candidates.map(async session => {
    const text = (await readFileFn(session.file).catch(() => '')).toLowerCase();
    if (!text) return;
    let count = 0, at = -1;
    for (const n of needles) {
      const i = text.indexOf(n);
      if (i < 0) return;                                  // AND semantics, same as prose search
      count++; if (at < 0) at = i;
    }
    hits.push({
      session, score: count, matchCount: count,
      best: { text: snippet(text, at, 60), role: 'a', index: 0 },
    });
  }));

  return hits.sort((a, b) => b.session.lastTs - a.session.lastTs);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/deep.test.ts && npm run lint`
Expected: 2 PASS, lint clean

- [ ] **Step 5: Route the surface through it**

In `src/surfaces/quickpick.ts`, import `deepSearch` and make `render` async for the deep path only:

```ts
import { deepSearch } from '../core/deep.js';

const render = async (value: string) => {
  if (!value.trim()) { qp.items = []; return; }
  const q = parseQuery(value, defaultWindow, Date.now());
  if (q.deep) {
    qp.busy = true;
    const hits = await deepSearch(index, q, Date.now());
    qp.busy = false;
    qp.items = hits.slice(0, 50).map(toRow);
    return;
  }
  /* …unchanged prose path… */
};
qp.onDidChangeValue(v => { void render(v); });
```

- [ ] **Step 6: Build, verify, commit**

Run: `npm run build && npm run lint && npx vitest run`
Then F5 and confirm `!` widens a query that returns nothing on prose alone.

```bash
git add src/core/deep.ts src/surfaces/quickpick.ts test/deep.test.ts
git commit -m "feat(core): live deep-search fallback over tool content"
```

---

### Task 11: README, icon and publish preparation

**Files:**
- Create: `README.md`, `CHANGELOG.md`, `.vscodeignore`, `resources/icon.png`
- Modify: `package.json` (icon, keywords)

- [ ] **Step 1: Write the README**

The README **is** the marketplace page (spec §12). It must contain the privacy paragraph verbatim in intent — this extension reads entire AI conversation transcripts, and that paragraph is what makes it installable by people subject to security review.

```markdown
# Claude Code Session Finder

Search **inside** your Claude Code conversations, not just their titles — then jump
straight into the session that matches.

## Why

Claude Code's built-in session picker matches on session *name*. Once a title stops
reminding you what happened inside a session, that session is effectively lost.
This extension indexes what you and Claude actually **said** and opens the match.

## Use it

`Ctrl+Alt+S` (`Cmd+Alt+S` on macOS), or **Claude: Search Sessions** in the palette.

| Type | To find |
|---|---|
| `paste image` | sessions containing both words |
| `"paste image"` | that exact phrase |
| `pr:1234` | the session that opened that PR |
| `since:30d`, `since:all` | widen past the default 7-day window |
| `!npm run build` | also search tool calls and results (slower) |

Enter opens the session — revealing an already-open tab, or opening a new one.
Sessions from other git worktrees open in a window on the right folder.

## Privacy

This extension reads your Claude Code transcripts from `~/.claude/projects`, extracts
the conversational text, and stores an index in VS Code's local extension storage on
your machine. **Nothing is uploaded, transmitted, or shared with anyone, including the
author.** There is no telemetry, no network access, and no analytics of any kind.

## Requirements

The official [Claude Code extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code),
installed automatically as a dependency.

## License

MIT
```

- [ ] **Step 2: Add `.vscodeignore` so the VSIX stays small**

```
.vscode/**
src/**
test/**
scripts/**
docs/**
out/**
node_modules/**
.eslintrc.json
tsconfig.json
vitest.config.ts
esbuild.mjs
**/*.map
```

- [ ] **Step 3: Add a 128×128 icon**

Create `resources/icon.png` (128×128). Add `"icon": "resources/icon.png"` and
`"keywords": ["claude", "claude code", "search", "sessions", "history"]` to `package.json`.

- [ ] **Step 4: Package and install locally**

Run:
```bash
npm run build
npx vsce package
code --install-extension claude-code-session-finder-0.0.1.vsix
```
Expected: installs cleanly, pulls in `anthropic.claude-code` as a dependency, and
`Ctrl+Alt+S` works in a normal (non-debug) window.

- [ ] **Step 5: Verify the VSIX contains no transcripts**

Run: `unzip -l claude-code-session-finder-0.0.1.vsix | grep -i 'fixture\|jsonl'`
Expected: **no output.** Fixtures are derived from real conversations; they must never ship.

- [ ] **Step 6: Commit**

```bash
git add README.md CHANGELOG.md .vscodeignore resources/icon.png package.json
git commit -m "docs: readme, icon and packaging configuration"
```

---

## Post-plan: publishing

Not a task — it requires credentials only the author has (spec §12, §14).

1. Resolve spec §14 open question 3: check `claude-code-session-finder` is free on the
   VS Code Marketplace and Open VSX.
2. Create the Azure DevOps org and a PAT scoped **Marketplace → Manage** across
   **All accessible organizations**.
3. Create the publisher; replace `<tbd>` in `package.json`.
4. `npx vsce login <publisher>` · `npx vsce publish minor`
5. `npx ovsx publish -p <ovsx-token>` for Cursor/Windsurf/VSCodium users.
6. Verify `vsce` flags and PAT scopes against current docs first — the spec's publishing
   notes were written from training data with a cutoff.

---

### Task 12: Extension-host surface test

Spec §11 requires one automated surface test, and it is the highest-value test in the
project: **F7 says VS Code re-filters QuickPick items by `label`.** If `alwaysShow`
regresses, the extension silently degrades into exactly the title-only search it exists
to replace — and every unit test still passes.

**Files:**
- Create: `test-e2e/runTest.ts`, `test-e2e/suite/index.ts`, `test-e2e/suite/quickpick.test.ts`
- Modify: `package.json` (add `@vscode/test-electron`, `mocha`, `glob`; add `test:e2e` script)

**Interfaces:**
- Consumes: `sessionFinder.search` command (Task 8)
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Add the dev dependencies and script**

```bash
npm i -D @vscode/test-electron mocha @types/mocha glob
```
Add to `package.json` scripts: `"test:e2e": "tsc -p . --outDir out && node out/test-e2e/runTest.js"`

- [ ] **Step 2: Write the failing test**

```ts
// test-e2e/suite/quickpick.test.ts
import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('Quick Pick surface', () => {
  test('the search command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('sessionFinder.search'));
  });

  test('alwaysShow items survive a non-matching filter value (F7)', async () => {
    // A label that deliberately does NOT contain the typed value. Without
    // alwaysShow, VS Code's built-in label filter removes it and the assertion fails.
    const qp = vscode.window.createQuickPick();
    qp.items = [{ label: 'Paste-image handling in the composer', alwaysShow: true }];
    qp.value = 'zzz-not-in-the-label';
    qp.show();
    await new Promise(r => setTimeout(r, 250));
    assert.strictEqual(qp.items.length, 1, 'alwaysShow must defeat the built-in filter');
    qp.dispose();
  });
});
```

- [ ] **Step 3: Write the harness**

```ts
// test-e2e/runTest.ts
import { runTests } from '@vscode/test-electron';
import * as path from 'node:path';

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');
  await runTests({ extensionDevelopmentPath, extensionTestsPath, launchArgs: ['--disable-extensions'] });
}
main().catch(err => { console.error('e2e failed', err); process.exit(1); });
```

```ts
// test-e2e/suite/index.ts
import Mocha from 'mocha';
import { glob } from 'glob';
import * as path from 'node:path';

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true });
  const root = __dirname;
  for (const f of await glob('**/*.test.js', { cwd: root })) mocha.addFile(path.resolve(root, f));
  await new Promise<void>((resolve, reject) =>
    mocha.run(failures => (failures ? reject(new Error(`${failures} tests failed`)) : resolve())));
}
```

**Note:** `--disable-extensions` disables `anthropic.claude-code` too, so this suite must
never assert on Claude Code's commands — that is what the manual checks in Task 8 Step 5
are for.

- [ ] **Step 4: Run the suite**

Run: `npm run test:e2e`
Expected: 2 PASS. In a headless container add `xvfb-run -a` before the command.

- [ ] **Step 5: Commit**

```bash
git add test-e2e package.json package-lock.json
git commit -m "test: extension-host suite pinning the alwaysShow filter behaviour"
```
