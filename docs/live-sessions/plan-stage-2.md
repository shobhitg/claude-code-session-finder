# Live Sessions — Stage 2 Implementation Plan (sidebar browser · right panel · custom titles → 0.3.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Sessions" sidebar view that lists ACTIVE sessions with their live state (spinner, needs-you, stalled) above the 50 most recent HISTORY sessions, opens any of them in a tab or in the right-hand panel, and looks native in every VS Code theme — built on the Stage 1 engine.

**Architecture:** A `WebviewViewProvider` (`surfaces/live-view.ts`) posts `Snapshot`s from the Stage 1 `LiveHost` to a webview whose renderer (`webview/main.ts`) is DOM glue over a pure, unit-tested view-model (`webview/model.ts`). The stylesheet (`webview/style.css`) is a token system aliased entirely to `--vscode-*` variables with a test that forbids hex literals. Opening reuses `core/open-args.ts`; the cross-window baton carries the requested target. `extract.ts` learns `custom-title`.

**Tech Stack:** TypeScript 5.x · esbuild (two bundles: node CJS for the host, browser IIFE for the webview) · `@vscode/codicons` (icon font, copied into `dist/codicons/`) · vitest · @vscode/test-electron (manifest e2e)

**Spec:** `docs/live-sessions/design.md` — §9.1 (protocol, layout, keyboard), §10 (design system), §11 (opening), §13 (tests), L10–L12. Stage 1 (`plan-stage-1.md`) must be merged first: this plan imports `LiveHost`, `Snapshot`, `stateIcon`, `openCommands`, `runOpen`, `executePlan(plan, ctx, where)` from it.

## Global Constraints

Every task's requirements implicitly include these, plus every constraint in `plan-stage-1.md`'s Global Constraints.

- **`src/core/**` MUST NOT import `vscode`** (eslint). `src/webview/**` MUST NOT import `vscode` either — it runs in a browser; it may import from `src/core/**` (bundled in).
- **`src/webview/style.css` contains no hex colour literal.** Every `--s-*` / `--st-*` token is `var(--vscode-…)`. Enforced by `test/webview-css.test.ts`.
- **Only `src/webview/main.ts` may use DOM APIs.** It pulls the types in via `/// <reference lib="dom" />` at its top; `tsconfig.json` `lib` stays `["ES2022"]`. A lib reference is program-wide, so the compiler will *not* catch `window` used elsewhere — reviewers do.
- **Webview CSP:** `default-src 'none'; style-src ${cspSource}; font-src ${cspSource}; script-src 'nonce-<nonce>'`. `localResourceRoots` is `[<extension>/dist]` only. `retainContextWhenHidden` is **not** set (D4).
- **Every message from the webview is shape-checked before use; unknown types are ignored** (spec §12).
- **Whole-file index work (`refreshIndex`) runs only when the view is visible (on show, then every 60 s) or when ACTIVE membership changes** — never per tick (L9, D6).
- **Right-panel open = `openCommands(id, 'right')`** (`sidebar.open` then `editor.open … { programmatic: 'honor-preferred-location' }`), and the first time it is used a one-time information message explains that Claude Code's default location has changed (spec §11).
- **ACTIVE ordering, state names and icon names come from `core/rows.ts`** (`stateIcon`); the view never re-derives them.
- **View id `sessionFinder.live`, container id `sessionFinder`.** VS Code auto-registers `sessionFinder.live.focus`.
- **`INDEX_VERSION` becomes `2`** (L12). Titles prefer the latest `custom-title` over the latest `ai-title`.
- **`publisher`/`name` never change.** `displayName` → `"Claude Code Sessions"` **only after the author confirms spec open question 1** (Task 8).
- Commit after every task; end each commit message with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Run `npm run typecheck && npm run lint && npm test` before every commit.

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `src/core/extract.ts`, `src/core/types.ts` (modify) | `custom-title` precedence; `INDEX_VERSION = 2` | 1 |
| `test/extract.test.ts` (modify — append) | title precedence | 1 |
| `src/baton.ts` (modify) | `Baton.where`; `openSession(id, where)` | 2 |
| `src/extension.ts` (modify) | hand-off claim passes `where` | 2, 7 |
| `test/baton-where.test.ts` (create) | `where` round-trip and hand-off | 2 |
| `esbuild.mjs`, `package.json` (modify), `resources/sessions.svg` (create) | webview bundle, codicons copy, view container, view, commands, menus | 3 |
| `test-e2e/suite/manifest.test.ts` (create) | manifest assertions | 3 |
| `src/webview/style.css` (create) | design tokens + components (spec §10) | 4 |
| `test/webview-css.test.ts` (create) | no hex; tokens alias `--vscode-*`; reduced motion | 4 |
| `src/webview/model.ts` (create) | pure view-model: labels, icon classes, sections | 5 |
| `test/webview-model.test.ts` (create) | labels, sections, skeleton, reduced motion | 5 |
| `src/webview/main.ts` (create) | DOM rendering, keyboard, messages | 6 |
| `src/surfaces/live-view.ts` (create) | `WebviewViewProvider`, HTML/CSP, message handling, index cadence | 7 |
| `src/live-host.ts`, `src/open.ts`, `src/extension.ts` (modify) | `session(id)`, `sweepNow()`; right-panel notice; view + command wiring | 7 |
| `package.json` version, `CHANGELOG.md`, `README.md` | 0.3.0 | 8 |

---

### Task 1: Custom titles (L12)

**Files:**
- Modify: `src/core/extract.ts` (the `Line` interface, the title locals, the `ai-title` branch, the `meta.title` assignment)
- Modify: `src/core/types.ts:1` (`INDEX_VERSION`)
- Test: `test/extract.test.ts` (append a `describe`)

**Interfaces:**
- `SessionMeta.title` (unchanged type) now prefers the latest `custom-title` record's `customTitle` over the latest `ai-title`'s `aiTitle`. Both are still indexed as prose role `'t'`.

- [ ] **Step 1: Write the failing test**

Append to `test/extract.test.ts` (it already imports `extractSession`, and defines `f()` and `line()`):

```ts
describe('titles (spec L12)', () => {
  it('a custom-title beats every ai-title, and the latest custom-title wins', () => {
    const text = [
      line({ type: 'custom-title', customTitle: 'My name', timestamp: '2026-08-01T00:00:00Z' }),
      line({ type: 'ai-title', aiTitle: 'Auto name', timestamp: '2026-08-01T00:00:01Z' }),
      line({ type: 'custom-title', customTitle: 'My better name', timestamp: '2026-08-01T00:00:02Z' }),
    ].join('\n');
    const { meta, prose } = extractSession(f(), text);
    expect(meta.title).toBe('My better name');
    expect(prose.filter(p => p.r === 't').map(p => p.x)).toEqual(['My name', 'Auto name', 'My better name']);
  });
  it('falls back to the latest ai-title when there is no custom-title', () => {
    const text = [line({ type: 'ai-title', aiTitle: 'First' }), line({ type: 'ai-title', aiTitle: 'Second' })].join('\n');
    expect(extractSession(f(), text).meta.title).toBe('Second');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/extract.test.ts`
Expected: FAIL — `expected 'Auto name' to be 'My better name'`.

- [ ] **Step 3: Implement**

In `src/core/extract.ts`:

```ts
interface Line {
  type?: string; cwd?: string; gitBranch?: string; timestamp?: string;
  isSidechain?: boolean; aiTitle?: string; customTitle?: string; prNumber?: number;
  message?: { content?: string | Part[] };
}
```

Replace `let title: string | null = null;` with:

```ts
  let aiTitle: string | null = null;
  let customTitle: string | null = null;      // L12: written by "Rename Session Tab"; beats every ai-title
```

Replace the `ai-title` line with:

```ts
    if (d.type === 'ai-title' && d.aiTitle) { aiTitle = d.aiTitle; prose.push({ r: 't', t, x: d.aiTitle }); continue; }
    if (d.type === 'custom-title' && d.customTitle) { customTitle = d.customTitle; prose.push({ r: 't', t, x: d.customTitle }); continue; }
```

and in the returned `meta`, `title,` becomes `title: customTitle ?? aiTitle,`.

In `src/core/types.ts`: `export const INDEX_VERSION = 2;` — titles are cached, so every cached entry must be re-extracted once (~1.6 s cold; v0.1: "never be clever").

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/extract.test.ts test/types.test.ts test/cache.test.ts`
Expected: PASS (`types.test.ts` asserts `>= 1`; `cache.test.ts`'s version test uses `999`).

- [ ] **Step 5: Commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/core/extract.ts src/core/types.ts test/extract.test.ts
git commit -m "feat(core): renamed sessions show their custom title

Claude Code writes a custom-title record when a tab is renamed; only ai-title
was read, so renamed sessions kept the stale AI title. INDEX_VERSION 1→2 to
re-extract cached titles. (spec L12)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The baton carries the target (`where`)

**Files:**
- Modify: `src/baton.ts`
- Modify: `src/extension.ts` (the `openSession` callback)
- Test: `test/baton-where.test.ts`

**Interfaces:**
- `interface Baton { sessionId: string; targetCwd: string; expiresAt: number; where?: OpenWhere }` — `where` absent on batons written by ≤ 0.1.1 and on unknown values.
- `ClaimDeps.openSession: (sessionId: string, where: OpenWhere) => Promise<void>` — `where` defaults to `'tab'` when the baton has none.

- [ ] **Step 1: Write the failing test**

Create `test/baton-where.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { claimBaton, claimPendingOpen } from '../src/baton.js';

const raw = (o: object) => JSON.stringify({ sessionId: 's', targetCwd: '/w', expiresAt: 2_000, ...o });

describe('baton.where (spec §6, §11)', () => {
  it('keeps a valid where, drops an invalid one, tolerates its absence', () => {
    expect(claimBaton(raw({ where: 'right' }), '/w', 1_000))
      .toEqual({ claim: { sessionId: 's', targetCwd: '/w', expiresAt: 2_000, where: 'right' } });
    expect(claimBaton(raw({ where: 'sideways' }), '/w', 1_000))
      .toEqual({ claim: { sessionId: 's', targetCwd: '/w', expiresAt: 2_000 } });
    expect(claimBaton(raw({}), '/w', 1_000))
      .toEqual({ claim: { sessionId: 's', targetCwd: '/w', expiresAt: 2_000 } });
  });
  it('claimPendingOpen passes where to openSession, defaulting to tab', async () => {
    const calls: unknown[][] = [];
    const deps = (where?: string) => ({
      read: async () => raw(where ? { where } : {}), remove: async () => {}, myFolder: '/w', now: 1_000,
      openSession: async (id: string, w: string) => { calls.push([id, w]); },
    });
    expect(await claimPendingOpen(deps('right'))).toBe('claimed');
    expect(await claimPendingOpen(deps())).toBe('claimed');
    expect(calls).toEqual([['s', 'right'], ['s', 'tab']]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/baton-where.test.ts`
Expected: FAIL — `openSession` receives one argument (`['s', undefined]`), and the invalid `where` survives.

- [ ] **Step 3: Implement**

In `src/baton.ts`:

```ts
import { samePath } from './core/paths.js';
import type { OpenWhere } from './core/open-args.js';

export interface Baton { sessionId: string; targetCwd: string; expiresAt: number; where?: OpenWhere }
```

In `claimBaton`, after the `expiresAt` check and before the `myFolder` check:

```ts
  // Spec §11: the target window honours the requested panel. Anything but a known value is
  // dropped, so a hand-written or older baton behaves like 0.1.x (a tab).
  if (b.where !== 'tab' && b.where !== 'right') delete b.where;
```

In `ClaimDeps`: `openSession: (sessionId: string, where: OpenWhere) => Promise<void>;`

In `claimPendingOpen`: `await deps.openSession(outcome.claim.sessionId, outcome.claim.where ?? 'tab');`

In `src/extension.ts`, the callback becomes:

```ts
    openSession: async (id, where) => {
      try {
        await runOpen(id, where);
      } catch {
        vscode.window.showErrorMessage('Claude Code did not accept the handed-off session.');
      }
    },
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/baton-where.test.ts test/baton.test.ts`
Expected: PASS — the pre-existing `baton.test.ts` cases are unaffected (batons without `where` are returned unchanged).

- [ ] **Step 5: Commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/baton.ts src/extension.ts test/baton-where.test.ts
git commit -m "feat: cross-window hand-off preserves the requested panel

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Build pipeline, icon font, and the manifest

**Files:**
- Modify: `esbuild.mjs`, `package.json` (`devDependencies`, `contributes.viewsContainers`, `contributes.views`, `contributes.commands`, `contributes.menus`)
- Create: `resources/sessions.svg`
- Create: `test-e2e/suite/manifest.test.ts`
- Create (placeholders so the build has inputs; replaced in Tasks 4 and 6): `src/webview/style.css`, `src/webview/main.ts`

**Interfaces:**
- Produces `dist/webview.js`, `dist/style.css`, `dist/codicons/codicon.css`, `dist/codicons/codicon.ttf` on `npm run build`.
- Produces the manifest ids every later task relies on: container `sessionFinder`, view `sessionFinder.live`, commands `sessionFinder.refresh`, `sessionFinder.openInTab`, `sessionFinder.openInRightPanel`.

- [ ] **Step 1: Write the failing e2e test**

Create `test-e2e/suite/manifest.test.ts`:

```ts
import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require(path.resolve(__dirname, '../../../package.json'));

// --disable-extensions keeps THIS extension from activating (its hard dependency is disabled —
// see quickpick.test.ts), so behaviour is unobservable here. VS Code still loads the manifest,
// and the manifest is what these tests pin down (spec §13).
suite('Live sessions manifest', () => {
  const manifest = () => vscode.extensions.getExtension(`${pkg.publisher}.${pkg.name}`)!.packageJSON;

  test('contributes the sessions view container and its webview view', () => {
    const c = manifest().contributes;
    assert.ok(c.viewsContainers?.activitybar?.some((v: { id: string }) => v.id === 'sessionFinder'), 'container sessionFinder');
    const views: Array<{ id: string; type: string }> = c.views?.sessionFinder ?? [];
    assert.ok(views.some(v => v.id === 'sessionFinder.live' && v.type === 'webview'), 'webview view sessionFinder.live');
  });

  test('contributes the session commands', () => {
    const ids = (manifest().contributes.commands as Array<{ command: string }>).map(c => c.command);
    for (const id of ['sessionFinder.search', 'sessionFinder.showSessions', 'sessionFinder.refresh',
                      'sessionFinder.openInTab', 'sessionFinder.openInRightPanel']) {
      assert.ok(ids.includes(id), `missing command ${id}`);
    }
  });

  test('contributes the live-state settings with the spec defaults', () => {
    const p = manifest().contributes.configuration.properties;
    assert.strictEqual(p['sessionFinder.activeWindow'].default, '4h');
    assert.strictEqual(p['sessionFinder.toolQuietSeconds'].default, 60);
    assert.strictEqual(p['sessionFinder.stalledMinutes'].default, 15);
  });

  test('keeps the activation and dependency contract', () => {
    const m = manifest();
    assert.deepStrictEqual(m.activationEvents, ['onStartupFinished']);
    assert.ok(m.extensionDependencies.includes('anthropic.claude-code'));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm run test:e2e`
(The `env -u` is required inside a Claude Code session — see the comment in `test-e2e/runTest.ts`. The first run downloads a VS Code build.)
Expected: FAIL — `container sessionFinder`.

- [ ] **Step 3: Add the icon font and the second bundle**

Run: `npm install --save-dev @vscode/codicons`
Then: `ls node_modules/@vscode/codicons/dist/codicon.css node_modules/@vscode/codicons/dist/codicon.ttf`
Expected: both files listed.

Replace `esbuild.mjs`:

```js
import { build } from 'esbuild';
import { mkdirSync, copyFileSync } from 'node:fs';

const minify = process.argv.includes('--minify');
// M10: dist/extension.js must not reference a .map the VSIX does not ship.
// `--no-sourcemap` is what vscode:prepublish uses; local builds keep the map.
const sourcemap = !process.argv.includes('--no-sourcemap');

await build({
  entryPoints: ['src/extension.ts'], bundle: true, outfile: 'dist/extension.js',
  external: ['vscode'], format: 'cjs', platform: 'node', target: 'node20', minify, sourcemap,
});

// The sidebar browser runs inside a webview — a browser — not the extension host (spec §14).
await build({
  entryPoints: ['src/webview/main.ts'], bundle: true, outfile: 'dist/webview.js',
  format: 'iife', platform: 'browser', target: 'es2022', minify, sourcemap,
});

// Static assets the view loads by URI. Codicons are the IDE's own icon font (spec §10).
mkdirSync('dist/codicons', { recursive: true });
copyFileSync('src/webview/style.css', 'dist/style.css');
for (const f of ['codicon.css', 'codicon.ttf']) {
  copyFileSync(`node_modules/@vscode/codicons/dist/${f}`, `dist/codicons/${f}`);
}
```

Create the two placeholders so the build runs before Tasks 4 and 6:

`src/webview/style.css`: `/* replaced in Task 4 */`
`src/webview/main.ts`: `/// <reference lib="dom" />\nexport {};\n`

- [ ] **Step 4: The activity-bar icon**

Create `resources/sessions.svg` (monochrome — VS Code uses activity-bar icons as masks, so only the shape matters):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <!-- Claude Code's six-arm session asterisk (the glyph in resources/icon.png) with a live dot. -->
  <g fill="#000000">
    <rect x="11" y="3" width="2" height="18" rx="1"/>
    <rect x="11" y="3" width="2" height="18" rx="1" transform="rotate(60 12 12)"/>
    <rect x="11" y="3" width="2" height="18" rx="1" transform="rotate(120 12 12)"/>
    <circle cx="19.5" cy="4.5" r="2.5"/>
  </g>
</svg>
```

(The no-hex rule is for the webview stylesheet; a mask SVG needs an opaque fill.)

- [ ] **Step 5: Contribute the container, view, commands and menus in `package.json`**

Add inside `contributes`:

```json
"viewsContainers": {
  "activitybar": [
    { "id": "sessionFinder", "title": "Claude Code Sessions", "icon": "resources/sessions.svg" }
  ]
},
"views": {
  "sessionFinder": [
    { "type": "webview", "id": "sessionFinder.live", "name": "Sessions", "contextualTitle": "Claude Code Sessions", "icon": "resources/sessions.svg" }
  ]
},
"menus": {
  "view/title": [
    { "command": "sessionFinder.search",  "when": "view == sessionFinder.live", "group": "navigation@1" },
    { "command": "sessionFinder.refresh", "when": "view == sessionFinder.live", "group": "navigation@2" }
  ]
}
```

Add to `contributes.commands` (and add `"icon": "$(search)"` to the existing `sessionFinder.search` entry so it renders in the view title):

```json
{ "command": "sessionFinder.refresh", "title": "Claude: Refresh Sessions", "icon": "$(refresh)" },
{ "command": "sessionFinder.openInTab", "title": "Claude: Open Session in Tab" },
{ "command": "sessionFinder.openInRightPanel", "title": "Claude: Open Session in Right Panel" }
```

- [ ] **Step 6: Build and check the package contents**

Run: `npm run build && ls dist dist/codicons && npx @vscode/vsce ls | grep -E 'dist/|resources/'`
Expected: `dist/extension.js dist/webview.js dist/style.css dist/codicons/codicon.css dist/codicons/codicon.ttf resources/icon.png resources/sessions.svg` all present in the VSIX listing; no `.map` when built with `--no-sourcemap`.

- [ ] **Step 7: Run the e2e again**

Run: `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm run test:e2e`
Expected: PASS — 4 manifest tests plus the 3 existing Quick Pick tests. (The commands are not yet *registered* in code; that is Task 7. The manifest is what is under test here.)

- [ ] **Step 8: Commit**

```bash
npm run typecheck && npm run lint && npm test
git add esbuild.mjs package.json package-lock.json resources/sessions.svg src/webview/style.css src/webview/main.ts test-e2e/suite/manifest.test.ts
git commit -m "build: webview bundle, codicon font, and the Sessions view container

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The design system (`webview/style.css`)

**Files:**
- Create (replace placeholder): `src/webview/style.css`
- Test: `test/webview-css.test.ts`

**Interfaces:**
- Class names consumed by Task 6's renderer: `.section`, `.section__header`, `.section__chevron`, `.section__count`, `.section__body`, `.list`, `.row`, `.row--link`, `.row__icon`, `.row__title`, `.row__time`, `.row__meta`, `.row__missing`, `.row__actions`, `.action`, `.empty`, `.skeleton`, `.skeleton__bar`, `.skeleton__bar--short`. Data attributes: `.section[data-collapsed]`, `.row[data-state="running|attention|history"]`, `.row[data-reason="tool-or-permission|your-turn|stalled"]`, `.row[aria-selected="true"]`.

- [ ] **Step 1: Write the failing test**

Create `test/webview-css.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(__dirname, '../src/webview/style.css'), 'utf8');

describe('webview stylesheet (spec §10, D7)', () => {
  it('contains no hex colour literal', () => {
    expect(css.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
  });
  it('every colour token is an alias of a --vscode-* variable', () => {
    const tokens = [...css.matchAll(/^\s*(--(?:s|st)-[a-z-]+):\s*([^;]+);/gm)];
    expect(tokens.length).toBeGreaterThan(12);
    for (const [, name, value] of tokens) expect(value, name).toMatch(/^var\(--vscode-/);
  });
  it('inherits font family and size from the IDE', () => {
    expect(css).toMatch(/--font:\s*var\(--vscode-font-family\)/);
    expect(css).toMatch(/--size:\s*var\(--vscode-font-size\)/);
  });
  it('respects prefers-reduced-motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
  it('styles every state the model can emit', () => {
    for (const sel of ['[data-state="running"]', '[data-reason="tool-or-permission"]', '[data-reason="your-turn"]',
                       '[data-reason="stalled"]', '[data-state="history"]']) {
      expect(css, sel).toContain(sel);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/webview-css.test.ts`
Expected: FAIL — the placeholder has no tokens.

- [ ] **Step 3: Write the stylesheet**

Replace `src/webview/style.css`:

```css
/* Claude Code Sessions — sidebar browser.
   Spec §10: no hex literal anywhere in this file. Every colour is a --vscode-* variable, so the
   view is right in the user's theme, Light+, High Contrast and themes that do not exist yet.
   The only values invented here are rhythm (spacing, radius, row height) and motion. */

:root {
  /* surface — inherited */
  --s-bg:        var(--vscode-sideBar-background);
  --s-fg:        var(--vscode-sideBar-foreground, var(--vscode-foreground));
  --s-muted:     var(--vscode-descriptionForeground);
  --s-hover:     var(--vscode-list-hoverBackground);
  --s-sel:       var(--vscode-list-activeSelectionBackground);
  --s-sel-fg:    var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
  --s-focus:     var(--vscode-focusBorder);
  --s-header-fg: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
  --s-badge-bg:  var(--vscode-badge-background);
  --s-badge-fg:  var(--vscode-badge-foreground);
  --s-skeleton:  var(--vscode-editorWidget-background);
  --s-link:      var(--vscode-textLink-foreground);
  --s-toolbar:   var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));

  /* state — the theme's own semantic ramp */
  --st-running:  var(--vscode-charts-blue);
  --st-needs:    var(--vscode-charts-yellow);
  --st-stalled:  var(--vscode-editorWarning-foreground);
  --st-idle:     var(--vscode-descriptionForeground);

  /* type — the IDE's */
  --font:      var(--vscode-font-family);
  --size:      var(--vscode-font-size);
  --size-meta: calc(var(--vscode-font-size) - 2px);
  --mono:      var(--vscode-editor-font-family);

  /* rhythm — the only primitives we invent */
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px;
  --radius: 4px;
  --row: 44px;                       /* two 22px lines: VS Code's list row height, doubled */
  --dur: 120ms; --ease: cubic-bezier(.2, 0, .2, 1);
}
@media (prefers-reduced-motion: reduce) {
  :root { --dur: 0ms; }
  .skeleton__bar, .codicon-modifier-spin { animation: none; }
}

* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0;
  background: var(--s-bg); color: var(--s-fg);
  font-family: var(--font); font-size: var(--size); line-height: 1.4;
}
body { padding-bottom: var(--sp-3); }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
main:focus-visible { outline: none; }

/* ─── sections ─────────────────────────────────────────────────────────────── */
.section { margin-top: var(--sp-1); }
.section__header {
  display: flex; align-items: center; gap: var(--sp-1);
  width: 100%; height: 22px; padding: 0 var(--sp-2) 0 var(--sp-1);
  text-align: left; color: var(--s-header-fg);
  font-size: var(--size-meta); font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
}
.section__header:hover { background: var(--s-hover); }
.section__header:focus-visible { outline: 1px solid var(--s-focus); outline-offset: -1px; }
.section__chevron { transition: transform var(--dur) var(--ease); }
.section[data-collapsed="true"] .section__chevron { transform: rotate(-90deg); }
.section[data-collapsed="true"] .section__body { display: none; }
.section__count {
  margin-left: auto; min-width: 18px; padding: 0 6px; border-radius: 9px; text-align: center;
  background: var(--s-badge-bg); color: var(--s-badge-fg);
  font-weight: 600; letter-spacing: 0; text-transform: none;
}

/* ─── rows ─────────────────────────────────────────────────────────────────── */
.list { list-style: none; margin: 0; padding: 0; }
.row {
  position: relative;
  display: grid; grid-template-columns: 16px 1fr auto; grid-template-rows: 22px 22px;
  column-gap: var(--sp-2); align-items: center;
  min-height: var(--row); padding: 0 var(--sp-2) 0 var(--sp-3);
  cursor: pointer;
  transition: background var(--dur) var(--ease);
  animation: row-in var(--dur) var(--ease);
}
@keyframes row-in { from { opacity: 0; } to { opacity: 1; } }
.row:hover { background: var(--s-hover); }
.row:focus-visible, .row[aria-selected="true"] { outline: 1px solid var(--s-focus); outline-offset: -1px; }
.row[aria-selected="true"] { background: var(--s-sel); color: var(--s-sel-fg); }
.row[aria-selected="true"] .row__meta,
.row[aria-selected="true"] .row__time { color: inherit; opacity: .85; }

.row__icon {
  grid-row: 1 / span 2; font-size: 16px; line-height: 1;
  display: flex; align-items: center; justify-content: center;
  transition: color var(--dur) var(--ease);
}
.row__title { grid-column: 2; grid-row: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.row__time {
  grid-column: 3; grid-row: 1;
  font-family: var(--mono); font-size: var(--size-meta); font-variant-numeric: tabular-nums;
  color: var(--s-muted); white-space: nowrap;
}
.row__meta {
  grid-column: 2 / span 2; grid-row: 2;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  font-size: var(--size-meta); color: var(--s-muted);
}
.row__missing { margin-left: var(--sp-1); }

/* ─── state language (spec §10 table) ──────────────────────────────────────── */
.row[data-state="running"] .row__icon { color: var(--st-running); }
.row[data-reason="tool-or-permission"] .row__icon { color: var(--st-needs); }
.row[data-reason="tool-or-permission"] .row__title { font-weight: 600; }
.row[data-reason="tool-or-permission"]::before {
  content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: var(--st-needs);
}
.row[data-reason="your-turn"] .row__icon { color: var(--s-fg); }
.row[data-reason="stalled"] .row__icon { color: var(--st-stalled); }
.row[data-reason="stalled"] { opacity: .7; }
.row[data-state="history"] .row__icon { color: var(--st-idle); }

/* ─── row actions: shown on hover AND on keyboard focus ────────────────────── */
.row__actions { grid-column: 3; grid-row: 1; display: none; gap: 2px; margin-left: var(--sp-1); }
.row:hover .row__actions, .row:focus-within .row__actions { display: flex; }
.row:hover .row__time,    .row:focus-within .row__time    { display: none; }
.action {
  width: 22px; height: 22px; border-radius: var(--radius);
  display: inline-flex; align-items: center; justify-content: center; color: inherit;
}
.action:hover { background: var(--s-toolbar); }
.action:focus-visible { outline: 1px solid var(--s-focus); outline-offset: -1px; }

/* ─── the "search all…" row ────────────────────────────────────────────────── */
.row--link { grid-template-rows: 22px; min-height: 22px; }
.row--link .row__icon { grid-row: 1; }
.row--link .row__title { color: var(--s-link); }
.row--link .row__time { font-family: var(--mono); }

/* ─── empty and loading ────────────────────────────────────────────────────── */
.empty { padding: var(--sp-2) var(--sp-3); color: var(--s-muted); font-size: var(--size-meta); }
.skeleton {
  height: var(--row); display: grid; grid-template-columns: 16px 1fr; column-gap: var(--sp-2);
  align-items: center; padding: 0 var(--sp-2) 0 var(--sp-3);
}
.skeleton__bar { height: 10px; border-radius: 5px; background: var(--s-skeleton); animation: shimmer 1.2s ease-in-out infinite; }
.skeleton__bar--short { width: 55%; }
@keyframes shimmer { 0%, 100% { opacity: .5; } 50% { opacity: 1; } }
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/webview-css.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/webview/style.css test/webview-css.test.ts
git commit -m "feat(webview): design tokens over VS Code theme variables

Every colour aliases a --vscode-* variable; only spacing, radius and motion are
ours. A test forbids hex literals so the view stays theme-native. (spec §10)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The view-model (`webview/model.ts`)

**Files:**
- Create: `src/webview/model.ts`
- Test: `test/webview-model.test.ts`

**Interfaces:**
- Consumes: `Snapshot`, `LiveRow`, `HistoryRow`, `stateIcon` from `src/core/rows.ts`.
- Produces (exported):
  - `interface RowVM { kind: 'session'; sessionId; title; meta; time; iconClass; state: 'running' | 'attention' | 'history'; reason?: string; missing: boolean }`
  - `interface LinkVM { kind: 'link'; title; meta; iconClass; action: 'search' }`
  - `interface SectionVM { id: 'active' | 'history'; label; count: number; rows: Array<RowVM | LinkVM>; empty: string | null; skeleton: boolean }`
  - `interface ViewModel { sections: SectionVM[] }`
  - `iconClass(codiconName: string): string` — `'loading~spin'` → `'codicon codicon-loading codicon-modifier-spin'`
  - `fmtDuration(ms: number): string`, `timeLabel(row: LiveRow, now: number): string`, `historyLabel(row: HistoryRow): string`, `metaLabel(row): string`
  - `viewModel(s: Snapshot, now: number, opts: { activeWindowLabel: string; searchKey: string; reducedMotion?: boolean }): ViewModel`

- [ ] **Step 1: Write the failing tests**

Create `test/webview-model.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { fmtDuration, timeLabel, historyLabel, metaLabel, iconClass, viewModel } from '../src/webview/model.js';
import type { Snapshot, LiveRow, HistoryRow } from '../src/core/rows.js';

const S = 1_000, M = 60 * S, H = 60 * M;
const now = 1_000 * H;
const live = (o: Partial<LiveRow>): LiveRow => ({
  sessionId: 'a', title: 'Ledger GUI', project: 'aida', branch: 'shobhit/ledger', pr: 20231, cwdExists: true,
  state: 'running', lastWriteMs: now - 10 * S, ...o,
});
const hist = (o: Partial<HistoryRow>): HistoryRow => ({
  sessionId: 'h', title: 'Old', project: 'aida', branch: null, pr: null, cwdExists: true,
  lastTs: new Date(2026, 8, 15, 12).getTime(), msgCount: 31, ...o,
});

describe('fmtDuration', () => {
  it('picks the unit by magnitude', () => {
    expect(fmtDuration(40 * S)).toBe('40 s');
    expect(fmtDuration(3 * M + 20 * S)).toBe('3 m');
    expect(fmtDuration(2.1 * H)).toBe('2.1 h');
    expect(fmtDuration(3 * H)).toBe('3 h');
    expect(fmtDuration(72 * H)).toBe('3 d');
    expect(fmtDuration(-5)).toBe('0 s');
  });
});

describe('timeLabel (spec §10 table)', () => {
  it('running: just now, then quiet N', () => {
    expect(timeLabel(live({ lastWriteMs: now - 10 * S }), now)).toBe('just now');
    expect(timeLabel(live({ lastWriteMs: now - 2 * M }), now)).toBe('quiet 2 m');
  });
  it('tool-or-permission says quiet; your-turn says ago; stalled is bare', () => {
    expect(timeLabel(live({ state: 'attention', reason: 'tool-or-permission', lastWriteMs: now - 3 * M }), now)).toBe('quiet 3 m');
    expect(timeLabel(live({ state: 'attention', reason: 'your-turn', lastWriteMs: now - 3 * M }), now)).toBe('3 m ago');
    expect(timeLabel(live({ state: 'attention', reason: 'stalled', lastWriteMs: now - 2.1 * H }), now)).toBe('2.1 h');
  });
});

describe('historyLabel / metaLabel / iconClass', () => {
  it('history shows the local date and message count', () => {
    expect(historyLabel(hist({}))).toBe('Sep 15 · 31 msgs');
  });
  it('meta joins project, branch and PR with middots, skipping blanks', () => {
    expect(metaLabel(live({}))).toBe('aida · shobhit/ledger · PR #20231');
    expect(metaLabel(hist({ project: '', branch: null, pr: null }))).toBe('');
  });
  it('iconClass expands the ~spin modifier', () => {
    expect(iconClass('loading~spin')).toBe('codicon codicon-loading codicon-modifier-spin');
    expect(iconClass('bell-dot')).toBe('codicon codicon-bell-dot');
  });
});

describe('viewModel', () => {
  const snap: Snapshot = {
    active: [live({ sessionId: 'a' }), live({ sessionId: 'b', state: 'attention', reason: 'your-turn', cwdExists: false })],
    history: [hist({ sessionId: 'h' })],
    totalSessions: 40, indexing: false,
  };
  const opts = { activeWindowLabel: '4h', searchKey: 'Ctrl+Alt+S' };

  it('builds ACTIVE and HISTORY with counts, states and the search-all link', () => {
    const vm = viewModel(snap, now, opts);
    expect(vm.sections.map(s => [s.id, s.label, s.count])).toEqual([['active', 'Active', 2], ['history', 'History', 38]]);
    const [active, history] = vm.sections;
    expect(active!.rows[0]).toMatchObject({ kind: 'session', sessionId: 'a', state: 'running', missing: false,
                                            iconClass: 'codicon codicon-loading codicon-modifier-spin' });
    expect(active!.rows[1]).toMatchObject({ kind: 'session', state: 'attention', reason: 'your-turn', missing: true,
                                            iconClass: 'codicon codicon-comment-discussion' });
    expect(history!.rows[0]).toMatchObject({ kind: 'session', sessionId: 'h', state: 'history', time: 'Sep 15 · 31 msgs' });
    expect(history!.rows.at(-1)).toEqual({ kind: 'link', title: 'Search all 40 sessions…', meta: 'Ctrl+Alt+S',
                                            iconClass: 'codicon codicon-search', action: 'search' });
  });
  it('empty ACTIVE explains the window; indexing shows a skeleton and no link', () => {
    const vm = viewModel({ active: [], history: [], totalSessions: 0, indexing: true }, now, opts);
    expect(vm.sections[0]!.empty).toBe('Nothing running. Sessions touched in the last 4h appear here.');
    expect(vm.sections[1]!.skeleton).toBe(true);
    expect(vm.sections[1]!.rows).toEqual([]);
  });
  it('reduced motion swaps the spinner for a static dot', () => {
    const vm = viewModel(snap, now, { ...opts, reducedMotion: true });
    expect(vm.sections[0]!.rows[0]).toMatchObject({ iconClass: 'codicon codicon-circle-large-filled' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/webview-model.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/webview/model.ts`**

```ts
import { stateIcon, type Snapshot, type LiveRow, type HistoryRow } from '../core/rows.js';

export interface RowVM {
  kind: 'session'; sessionId: string; title: string; meta: string; time: string; iconClass: string;
  state: 'running' | 'attention' | 'history'; reason?: string; missing: boolean;
}
export interface LinkVM { kind: 'link'; title: string; meta: string; iconClass: string; action: 'search' }
export interface SectionVM {
  id: 'active' | 'history'; label: string; count: number; rows: Array<RowVM | LinkVM>;
  empty: string | null; skeleton: boolean;
}
export interface ViewModel { sections: SectionVM[] }

/** `loading~spin` → `codicon codicon-loading codicon-modifier-spin` (the IDE's own spinner). */
export function iconClass(name: string): string {
  const [base, mod] = name.split('~');
  return `codicon codicon-${base}${mod ? ` codicon-modifier-${mod}` : ''}`;
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} m`;
  const h = ms / 3_600_000;
  if (h < 48) return `${h.toFixed(1).replace(/\.0$/, '')} h`;
  return `${Math.round(h / 24)} d`;
}

/** Spec §10 table, "Time label" column. */
export function timeLabel(row: LiveRow, now: number): string {
  const quiet = now - row.lastWriteMs;
  if (row.state === 'running') return quiet < 45_000 ? 'just now' : `quiet ${fmtDuration(quiet)}`;
  switch (row.reason) {
    case 'tool-or-permission': return `quiet ${fmtDuration(quiet)}`;
    case 'your-turn': return `${fmtDuration(quiet)} ago`;
    default: return fmtDuration(quiet);
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function historyLabel(row: HistoryRow): string {
  const d = new Date(row.lastTs);
  return `${MONTHS[d.getMonth()]} ${d.getDate()} · ${row.msgCount} msgs`;
}

export function metaLabel(r: { project: string; branch: string | null; pr: number | null }): string {
  return [r.project, r.branch ?? '', r.pr ? `PR #${r.pr}` : ''].filter(Boolean).join(' · ');
}

export function viewModel(
  s: Snapshot, now: number,
  opts: { activeWindowLabel: string; searchKey: string; reducedMotion?: boolean },
): ViewModel {
  // Under reduced motion the spinner becomes a static dot in the running colour (spec §10).
  const runningIcon = opts.reducedMotion ? 'circle-large-filled' : 'loading~spin';

  const active: RowVM[] = s.active.map(r => {
    const vm: RowVM = {
      kind: 'session', sessionId: r.sessionId, title: r.title, meta: metaLabel(r), time: timeLabel(r, now),
      iconClass: iconClass(r.state === 'running' ? runningIcon : stateIcon(r)), state: r.state, missing: !r.cwdExists,
    };
    if (r.reason) vm.reason = r.reason;
    return vm;
  });

  const history: Array<RowVM | LinkVM> = s.history.map(r => ({
    kind: 'session', sessionId: r.sessionId, title: r.title, meta: metaLabel(r), time: historyLabel(r),
    iconClass: iconClass('history'), state: 'history', missing: !r.cwdExists,
  }));
  if (!s.indexing) {
    history.push({ kind: 'link', title: `Search all ${s.totalSessions} sessions…`, meta: opts.searchKey,
                   iconClass: iconClass('search'), action: 'search' });
  }

  const historyCount = Math.max(0, s.totalSessions - s.active.length);
  return {
    sections: [
      { id: 'active', label: 'Active', count: active.length, rows: active, skeleton: false,
        empty: active.length ? null : `Nothing running. Sessions touched in the last ${opts.activeWindowLabel} appear here.` },
      { id: 'history', label: 'History', count: historyCount, rows: history,
        skeleton: s.indexing && history.length === 0, empty: null },
    ],
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/webview-model.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/webview/model.ts test/webview-model.test.ts
git commit -m "feat(webview): pure view-model for the sessions list

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The renderer (`webview/main.ts`)

**Files:**
- Create (replace placeholder): `src/webview/main.ts`

**Interfaces:**
- Consumes: `viewModel`, `timeLabel`, `ViewModel`, `RowVM`, `LinkVM` (model.ts); `Snapshot` (core/rows.ts).
- Inbound message (from Task 7): `{ type: 'snapshot'; snapshot: Snapshot; now: number; activeWindow: string }`.
- Outbound messages (handled in Task 7): `{ type: 'ready' }` · `{ type: 'open'; sessionId; where: 'tab' | 'right' }` · `{ type: 'transcript' | 'copyLink' | 'reveal'; sessionId }` · `{ type: 'search' }`.
- Expects the HTML to contain `<main id="app" tabindex="0">` (Task 7).
- DOM code is not unit-tested (no jsdom in this repo); everything with logic lives in `model.ts`.

- [ ] **Step 1: Write `src/webview/main.ts`**

```ts
/// <reference lib="dom" />
// The sidebar browser's DOM glue. Everything with logic is in model.ts (tested); this file only
// turns a ViewModel into elements and user gestures into messages (spec §9.1).
import { viewModel, timeLabel, type ViewModel, type RowVM, type LinkVM } from './model.js';
import type { Snapshot } from '../core/rows.js';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};
const api = acquireVsCodeApi();

interface Inbound { type: 'snapshot'; snapshot: Snapshot; now: number; activeWindow: string }
interface UiState { collapsed: Record<string, boolean> }

let snapshot: Snapshot | null = null;
let clockOffset = 0;                       // host clock − webview clock; labels use the host's clock
let activeWindow = '4h';
const ui: UiState = (api.getState() as UiState | undefined) ?? { collapsed: {} };
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const searchKey = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘⌥S' : 'Ctrl+Alt+S';
const root = document.getElementById('app') as HTMLElement;

const post = (message: unknown): void => api.postMessage(message);

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string> = {}, ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) el.append(c);
  return el;
}

function actionButton(icon: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = h('button', { class: 'action', title: label, 'aria-label': label },
    h('i', { class: `codicon codicon-${icon}`, 'aria-hidden': 'true' }));
  b.addEventListener('click', e => { e.stopPropagation(); onClick(); });
  return b;
}

function rowEl(r: RowVM | LinkVM): HTMLLIElement {
  if (r.kind === 'link') {
    const li = h('li', { class: 'row row--link', role: 'option', tabindex: '-1', 'data-action': r.action },
      h('i', { class: `row__icon ${r.iconClass}`, 'aria-hidden': 'true' }),
      h('span', { class: 'row__title' }, r.title),
      h('span', { class: 'row__time' }, r.meta));
    li.addEventListener('click', () => post({ type: 'search' }));
    return li;
  }
  const li = h('li', { class: 'row', role: 'option', tabindex: '-1', 'data-state': r.state, 'data-id': r.sessionId, title: r.title });
  if (r.reason) li.dataset.reason = r.reason;
  const actions = h('span', { class: 'row__actions' },
    actionButton('window', 'Open in tab', () => post({ type: 'open', sessionId: r.sessionId, where: 'tab' })),
    actionButton('layout-sidebar-right', 'Open in right panel', () => post({ type: 'open', sessionId: r.sessionId, where: 'right' })),
    actionButton('link', 'Copy deep link', () => post({ type: 'copyLink', sessionId: r.sessionId })),
    actionButton('folder', 'Reveal folder', () => post({ type: 'reveal', sessionId: r.sessionId })),
    actionButton('file-code', 'Open transcript', () => post({ type: 'transcript', sessionId: r.sessionId })),
  );
  const meta = h('span', { class: 'row__meta' }, r.meta);
  if (r.missing) meta.append(h('span', { class: 'row__missing' }, '⚠ folder missing'));
  li.append(
    h('i', { class: `row__icon ${r.iconClass}`, 'aria-hidden': 'true' }),
    h('span', { class: 'row__title' }, r.title),
    h('span', { class: 'row__time' }, r.time),
    actions,
    meta,
  );
  li.addEventListener('click', () => post({ type: 'open', sessionId: r.sessionId, where: 'tab' }));
  return li;
}

function sectionEl(s: ViewModel['sections'][number]): HTMLElement {
  const collapsed = ui.collapsed[s.id] === true;
  const header = h('button', { class: 'section__header', 'aria-expanded': String(!collapsed) },
    h('i', { class: 'section__chevron codicon codicon-chevron-down', 'aria-hidden': 'true' }),
    h('span', {}, s.label),
    h('span', { class: 'section__count' }, String(s.count)));
  header.addEventListener('click', () => { ui.collapsed[s.id] = !collapsed; api.setState(ui); render(); });
  const body = h('div', { class: 'section__body' });
  if (s.skeleton) {
    for (let i = 0; i < 3; i++) {
      body.append(h('div', { class: 'skeleton' }, h('span', {}),
        h('span', { class: `skeleton__bar${i % 2 ? ' skeleton__bar--short' : ''}` })));
    }
  } else if (s.empty) {
    body.append(h('div', { class: 'empty' }, s.empty));
  } else {
    const ul = h('ul', { class: 'list', role: 'listbox', 'aria-label': s.label });
    for (const r of s.rows) ul.append(rowEl(r));
    body.append(ul);
  }
  return h('section', { class: 'section', 'data-collapsed': String(collapsed) }, header, body);
}

const hostNow = (): number => Date.now() + clockOffset;

function render(): void {
  if (!snapshot) return;
  const focusedId = (document.activeElement as HTMLElement | null)?.dataset.id;
  const vm = viewModel(snapshot, hostNow(), { activeWindowLabel: activeWindow, searchKey, reducedMotion });
  root.replaceChildren(...vm.sections.map(sectionEl));
  if (focusedId) root.querySelector<HTMLElement>(`[data-id="${focusedId}"]`)?.focus();
}

/** Between snapshots only the relative-time labels change (spec §8) — update those, not the tree. */
function refreshTimes(): void {
  if (!snapshot) return;
  const now = hostNow();
  for (const r of snapshot.active) {
    const el = root.querySelector<HTMLElement>(`.row[data-id="${r.sessionId}"] .row__time`);
    if (el) el.textContent = timeLabel(r, now);
  }
}

/** Roving focus: ↑/↓ move, Enter opens in a tab, Shift+Enter in the right panel, T transcript, / search. */
root.addEventListener('keydown', e => {
  const rows = Array.from(root.querySelectorAll<HTMLElement>('.row'));   // not [...], which needs lib dom.iterable
  const current = document.activeElement as HTMLElement | null;
  const i = current ? rows.indexOf(current) : -1;
  const focus = (j: number) => rows[Math.max(0, Math.min(rows.length - 1, j))]?.focus();
  const id = current?.dataset.id;
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); focus(i + 1); break;
    case 'ArrowUp':   e.preventDefault(); focus(i - 1); break;
    case 'Home':      e.preventDefault(); focus(0); break;
    case 'End':       e.preventDefault(); focus(rows.length - 1); break;
    case 'Enter':
      e.preventDefault();
      if (id) post({ type: 'open', sessionId: id, where: e.shiftKey ? 'right' : 'tab' });
      else if (current?.dataset.action === 'search') post({ type: 'search' });
      break;
    case 't': case 'T': if (id) post({ type: 'transcript', sessionId: id }); break;
    case '/': e.preventDefault(); post({ type: 'search' }); break;
    case 'Escape': current?.blur(); break;
  }
});
// Tab lands on <main>; hand focus to the first row so the roving list takes over.
root.addEventListener('focus', () => root.querySelector<HTMLElement>('.row')?.focus());

window.addEventListener('message', (e: MessageEvent<Inbound>) => {
  const m = e.data;
  if (!m || m.type !== 'snapshot') return;
  snapshot = m.snapshot;
  activeWindow = m.activeWindow;
  clockOffset = m.now - Date.now();
  render();
});
setInterval(refreshTimes, 1_000);
post({ type: 'ready' });
```

- [ ] **Step 2: Typecheck, lint and build**

Run: `npm run typecheck && npm run lint && npm run build && ls -la dist/webview.js`
Expected: clean; `dist/webview.js` exists. If typecheck complains about `HTMLElementTagNameMap` or `document`, the `/// <reference lib="dom" />` line is not the first line of the file.

- [ ] **Step 3: Commit**

```bash
npm test
git add src/webview/main.ts
git commit -m "feat(webview): render the sessions list with roving keyboard focus

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The view provider and the wiring

**Files:**
- Create: `src/surfaces/live-view.ts`
- Modify: `src/live-host.ts` (add `session(id)` and `sweepNow()`)
- Modify: `src/open.ts` (one-time right-panel notice inside `executePlan`)
- Modify: `src/extension.ts` (register the provider; `sessionFinder.showSessions` focuses the view; `refresh`, `openInTab`, `openInRightPanel` commands)

**Interfaces:**
- Consumes: `LiveHost` (Stage 1) with two new members: `session(sessionId: string): SessionMeta | undefined`, `sweepNow(): Promise<void>`; `Snapshot`, `stateIcon` (rows.ts); `planOpen` (resolve.ts); `executePlan`, `folderUri`, `openTranscript` (open.ts); `OpenWhere` (open-args.ts).
- Produces: `class LiveViewProvider implements vscode.WebviewViewProvider`, `const VIEW_ID = 'sessionFinder.live'` in `src/surfaces/live-view.ts`.

- [ ] **Step 1: Extend `LiveHost`**

In `src/live-host.ts` add the import `import type { SessionMeta } from './core/types.js';` (merge with the existing `SearchIndex` import) and two members:

```ts
  /** Index metadata for a session id, or undefined until the next refresh indexes it. */
  session(sessionId: string): SessionMeta | undefined {
    return this.index?.sessions.find(s => s.sessionId === sessionId);
  }

  /** The Refresh button: re-enumerate now instead of waiting for the 10 s sweep. */
  sweepNow(): Promise<void> {
    return this.tracker?.sweep() ?? Promise.resolve();
  }
```

- [ ] **Step 2: The one-time right-panel notice in `open.ts`**

`sidebar.open` changes a persistent Claude Code preference (spec §11). Add to `src/open.ts`:

```ts
const RIGHT_PANEL_NOTICE = 'sessionFinder.rightPanelNoticeShown';

/** Spec §11: opening in the right panel also changes Claude Code's default location. Say so once. */
async function noticeRightPanelOnce(ctx: vscode.ExtensionContext): Promise<void> {
  if (ctx.globalState.get<boolean>(RIGHT_PANEL_NOTICE)) return;
  await ctx.globalState.update(RIGHT_PANEL_NOTICE, true);
  void vscode.window.showInformationMessage(
    'Opening in the right panel also makes it Claude Code\'s default location for new sessions. ' +
    'Run "Claude Code: Open in New Tab" once to switch back.');
}
```

and at the top of the `here` branch in `executePlan`, before `runOpen`: `if (where === 'right') await noticeRightPanelOnce(ctx);`

- [ ] **Step 3: Create `src/surfaces/live-view.ts`**

```ts
import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { LiveHost } from '../live-host.js';
import type { Snapshot } from '../core/rows.js';
import { planOpen } from '../core/resolve.js';
import type { OpenWhere } from '../core/open-args.js';
import { executePlan, folderUri, openTranscript } from '../open.js';

export const VIEW_ID = 'sessionFinder.live';

// One member per `type`, not `'transcript' | 'copyLink' | 'reveal'` in one member: the early
// returns in onMessage narrow by discriminant, and a shared member would leave `raw` un-narrowed
// at the `open` step (TS2339 on `raw.where`).
type Inbound =
  | { type: 'ready' }
  | { type: 'search' }
  | { type: 'open'; sessionId: string; where: OpenWhere }
  | { type: 'transcript'; sessionId: string }
  | { type: 'copyLink'; sessionId: string }
  | { type: 'reveal'; sessionId: string };

/** Spec §12: every field read from a webview message is checked first; unknown shapes are ignored. */
function isInbound(m: unknown): m is Inbound {
  if (typeof m !== 'object' || m === null) return false;
  const o = m as Record<string, unknown>;
  switch (o.type) {
    case 'ready': case 'search': return true;
    case 'open': return typeof o.sessionId === 'string' && (o.where === 'tab' || o.where === 'right');
    case 'transcript': case 'copyLink': case 'reveal': return typeof o.sessionId === 'string';
    default: return false;
  }
}

/**
 * Spec §9.1. The host owns the state (D4); this class only ships Snapshots to the webview and
 * turns its messages into the same actions the Quick Pick offers. retainContextWhenHidden is
 * deliberately not set: the webview re-renders from the next snapshot after `ready`.
 */
export class LiveViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private indexTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly host: LiveHost) {
    ctx.subscriptions.push(host.onSnapshot(s => this.post(s)));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const dist = vscode.Uri.joinPath(this.ctx.extensionUri, 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    view.webview.html = this.html(view.webview, dist);
    view.webview.onDidReceiveMessage(m => void this.onMessage(m));
    // D6: whole-file index work only while someone is looking.
    view.onDidChangeVisibility(() => this.onVisibility(view.visible));
    view.onDidDispose(() => { this.onVisibility(false); this.view = undefined; });
    this.onVisibility(view.visible);
  }

  private onVisibility(visible: boolean): void {
    if (this.indexTimer) clearInterval(this.indexTimer);
    this.indexTimer = undefined;
    if (!visible) return;
    void this.host.refreshIndex();
    this.indexTimer = setInterval(() => void this.host.refreshIndex(), 60_000);
  }

  private post(snapshot: Snapshot): void {
    if (!this.view) return;
    const activeWindow = vscode.workspace.getConfiguration('sessionFinder').get<string>('activeWindow', '4h');
    void this.view.webview.postMessage({ type: 'snapshot', snapshot, now: Date.now(), activeWindow });
  }

  private async onMessage(raw: unknown): Promise<void> {
    if (!isInbound(raw)) return;
    try {
      if (raw.type === 'ready') { this.post(this.host.snapshot); return; }
      if (raw.type === 'search') { await vscode.commands.executeCommand('sessionFinder.search'); return; }
      if (raw.type === 'copyLink') {
        await vscode.env.clipboard.writeText(`vscode://anthropic.claude-code/open?session=${raw.sessionId}`);
        vscode.window.setStatusBarMessage('Deep link copied', 3000);
        return;
      }
      const m = this.host.session(raw.sessionId);
      if (!m) { vscode.window.showWarningMessage('That session is not in the index yet — try again in a moment.'); return; }
      if (raw.type === 'transcript') { await openTranscript(m.file); return; }
      if (raw.type === 'reveal') {
        if (m.cwd) await vscode.commands.executeCommand('revealInExplorer', folderUri(m.cwd, this.ctx));   // F8
        return;
      }
      // open — v0.1 §10: the transcript may have gone between indexing and the click.
      if (!existsSync(m.file)) {
        vscode.window.showWarningMessage('That session transcript no longer exists on disk.');
        void this.host.refreshIndex();
        return;
      }
      const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.path);
      await executePlan(planOpen(m, folders), this.ctx, raw.where);
    } catch (err) {
      vscode.window.showErrorMessage(`Action failed: ${String(err)}`);
    }
  }

  private html(webview: vscode.Webview, dist: vscode.Uri): string {
    const nonce = randomBytes(16).toString('hex');
    const uri = (p: string) => webview.asWebviewUri(vscode.Uri.joinPath(dist, p)).toString();
    const csp = `default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri('codicons/codicon.css')}">
<link rel="stylesheet" href="${uri('style.css')}">
<title>Claude Code Sessions</title>
</head><body>
<main id="app" tabindex="0" aria-label="Claude Code sessions"></main>
<script nonce="${nonce}" src="${uri('webview.js')}"></script>
</body></html>`;
  }
}
```

- [ ] **Step 4: Wire it in `src/extension.ts`**

Imports:

```ts
import { LiveViewProvider, VIEW_ID } from './surfaces/live-view.js';
import { stateIcon } from './core/rows.js';
import { planOpen } from './core/resolve.js';
import type { OpenWhere } from './core/open-args.js';
import { executePlan } from './open.js';           // merge with the existing import from './open.js'
```

Replace the Stage 1 `SHOW_SESSIONS` registration (which ran the Quick Pick) and add the view and commands, after `host` is created:

```ts
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, new LiveViewProvider(ctx, host)),
    vscode.commands.registerCommand(SHOW_SESSIONS, () => vscode.commands.executeCommand(`${VIEW_ID}.focus`)),
    vscode.commands.registerCommand('sessionFinder.refresh', () => Promise.all([host.sweepNow(), host.refreshIndex()])),
    vscode.commands.registerCommand('sessionFinder.openInTab', (id?: string) => openFromPalette(ctx, host, id, 'tab')),
    vscode.commands.registerCommand('sessionFinder.openInRightPanel', (id?: string) => openFromPalette(ctx, host, id, 'right')),
  );
```

Add the helper at module level:

```ts
/** Palette entry points: pick an ACTIVE session (or take an id) and open it where asked. */
async function openFromPalette(ctx: vscode.ExtensionContext, host: LiveHost, sessionId: string | undefined, where: OpenWhere): Promise<void> {
  let id = sessionId;
  if (!id) {
    const rows = host.snapshot.active;
    const picked = await vscode.window.showQuickPick(
      rows.map(r => ({ label: `$(${stateIcon(r)}) ${r.title}`, description: [r.project, r.branch].filter(Boolean).join(' · '),
                       id: r.sessionId, alwaysShow: true })),                                   // F7
      { placeHolder: rows.length ? 'Open which session?' : 'No active sessions' });
    id = picked?.id;
  }
  if (!id) return;
  const m = host.session(id);
  if (!m) { vscode.window.showWarningMessage('That session is not in the index yet — try again in a moment.'); return; }
  const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.path);
  await executePlan(planOpen(m, folders), ctx, where);
}
```

- [ ] **Step 5: Typecheck, lint, tests, build, e2e**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Then: `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm run test:e2e`
Expected: all clean; 7 e2e tests pass.

- [ ] **Step 6: Manual QA (spec §13) in the Extension Development Host — record results in the PR**

1. The activity bar shows the sessions icon; the view opens with ACTIVE and HISTORY; while the index builds cold, HISTORY shows three shimmering skeleton rows, then rows.
2. A working session shows the spinner and "just now"; stop interacting and watch the label tick to "quiet 40 s" without any flicker of the rest of the list.
3. Ask a session for a long answer; 2 min in it still spins (L5).
4. Trigger a permission prompt; after 60 s the row gets the yellow accent bar, bold title and `bell-dot`.
5. Let a session finish: `comment-discussion`, "1 m ago", ordered above running rows.
6. Hover a row: five action buttons appear where the time was. `Tab` into the list, `↓↓`, `Enter` opens in a tab; `Shift+Enter` opens in the **right** panel and shows the one-time notice the first time only.
7. A HISTORY row from another worktree: `Shift+Enter` opens a window on that folder with the session in its right panel (baton `where`).
8. Switch themes: Dark Modern, Light Modern, Dark High Contrast — colours follow; no hard-coded colour anywhere.
9. OS "reduce motion" on: spinner becomes a static dot, no shimmer.
10. Rename a session tab in Claude Code; within 60 s (or on Refresh) the view shows the custom name (L12).
11. `session-monitor` counts vs the ACTIVE section at the same minute — note both numbers.

- [ ] **Step 7: Commit**

```bash
git add src/surfaces/live-view.ts src/live-host.ts src/open.ts src/extension.ts
git commit -m "feat: Sessions sidebar — live state above searchable history, open in tab or right panel

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Release 0.3.0

**Files:**
- Modify: `package.json` (`version`; `displayName`/`description`/`keywords` if confirmed), `CHANGELOG.md`, `README.md`

- [ ] **Step 1: Confirm the rename (spec §16 Q1) with the author before this step.** If confirmed, in `package.json`:

```json
"displayName": "Claude Code Sessions",
"description": "See which Claude Code sessions are running or waiting on you, browse and search every session's content, and open any of them in a tab or the right panel.",
"keywords": ["claude", "claude code", "sessions", "search", "history", "status"]
```

`name` and `publisher` do not change. If declined, skip this step.

- [ ] **Step 2: Version**

Run: `npm version 0.3.0 --no-git-tag-version`

- [ ] **Step 3: CHANGELOG**

Insert under `# Changelog`:

```markdown
## 0.3.0

**A Sessions view.** The activity bar gets a sessions icon. ACTIVE lists every
session written in the last few hours with its live state — spinner, "waiting on
a tool or a permission prompt", "your turn", stalled — and HISTORY lists the 50
most recent below it, with "Search all…" leading into the content search. Rows
open in a tab (`Enter`) or in the right-hand panel (`Shift+Enter`); hover or focus
a row for deep link, reveal folder and transcript. Colours, fonts and icons come
from your VS Code theme: the stylesheet has no colour of its own, and a test
keeps it that way.

**Right panel.** Claude Code has no per-call "open here" — its `sidebar.open`
sets a sticky preference, then `editor.open` honours it. So the first time you
open in the right panel, a notice explains that new sessions will now open there
too, and how to switch back.

**Renamed sessions show their name.** Claude Code records a rename as a
`custom-title`; only the AI-generated title was read. The index version bumps,
so the first search after upgrading rebuilds it (about a second).

Also: a cross-window hand-off now remembers whether you asked for a tab or the
right panel.
```

- [ ] **Step 4: README**

Add after "See what's running":

```markdown
## Browse sessions

The **Sessions** view (activity bar) shows what is live and what is history:

- **Active** — sessions written in the last `sessionFinder.activeWindow`, most
  urgent first: waiting on you, your turn, running, stalled. The time label
  says how long a session has been quiet.
- **History** — the 50 most recent sessions, and "Search all…" for the rest.

`↑`/`↓` move, `Enter` opens in a tab, `Shift+Enter` opens in the **right panel**,
`T` opens the transcript, `/` opens search. Hover or focus a row for the action
buttons.

Opening in the right panel uses Claude Code's own "Open in Side Bar", which also
becomes its default for new sessions until you run "Claude Code: Open in New Tab".
```

- [ ] **Step 5: Package, inspect, commit, tag**

Run: `npm run build && npx @vscode/vsce ls && npm run package`
Expected: the VSIX lists `dist/webview.js`, `dist/style.css`, `dist/codicons/*`, `resources/sessions.svg`; no `src/`, `test/`, `docs/`.

```bash
npm run typecheck && npm run lint && npm test
git add package.json package-lock.json CHANGELOG.md README.md
git commit -m "chore: release 0.3.0 — Sessions view

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git tag v0.3.0
```

Publishing is the author's step, as before.

---

## Self-review

**Spec coverage (Stage 2 scope):** §9.1 protocol/layout/keyboard → Tasks 6, 7; §10 tokens, state table, motion, reduced motion → Tasks 4, 5; §11 tab/right/baton/notice → Tasks 2, 7 (`open.ts`), Stage 1's `open-args.ts`; §12 message validation, vanished file, unknown types → Task 7; §13 unit tests → Tasks 1, 2, 4, 5; §13 manifest e2e → Task 3; §13 manual QA → Task 7 Step 6; §14 bundles, codicons, `.vscodeignore`, DOM lib reference → Tasks 3, 6; L11 → Tasks 4–7; L12 → Task 1; D1 rename gated on confirmation → Task 8; D9 (no search box; "Search all…" link) → Task 5.

**Placeholder scan:** none. The two placeholder files created in Task 3 are replaced by Tasks 4 and 6 and named as such.

**Type consistency:** `Inbound` union in `live-view.ts` matches the messages `main.ts` posts (`ready`, `search`, `open{sessionId,where}`, `transcript|copyLink|reveal{sessionId}`); the host→view message `{ type: 'snapshot', snapshot, now, activeWindow }` matches `main.ts`'s `Inbound`. `viewModel(s, now, { activeWindowLabel, searchKey, reducedMotion? })` matches its one call site. `LiveHost.session()` / `sweepNow()` are used only by `live-view.ts` and `extension.ts` under those names. `executePlan(plan, ctx, where)` is Stage 1's signature. `VIEW_ID` equals the manifest's `sessionFinder.live`; `SHOW_SESSIONS` (Stage 1) equals `sessionFinder.showSessions`.
