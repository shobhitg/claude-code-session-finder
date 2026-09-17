# Claude Code Session Finder — Design

> The extension shipped under this name through 0.2.x and is **Claude Code Sessions** from 0.3.0
> (same extension id, `shobhitg.claude-code-session-finder`). This document is the original search
> design; `live-sessions/design.md` covers the live state, the Sessions view and the Session View.

**Status:** approved design, not yet implemented
**Date:** 2026-08-24
**Repo:** github.com/shobhitg/claude-code-session-finder (MIT, public)

## 1. Problem

The Claude Code VS Code extension's built-in session search matches only on
session *names*. Sessions are therefore effectively unfindable once their title
no longer reminds you what happened inside them — which is most of the time,
since titles are auto-generated from the first prompt and work drifts.

The user runs most sessions in separate git worktrees, so recall must span every
worktree and every workspace folder, not just the currently open one.

**Goal:** search the *content* of every Claude Code session on the machine and
open the matching session in VS Code in one keystroke.

## 2. Measured baseline

All figures measured on the author's corpus, 2026-08-24. They are the basis for
most decisions below; re-measure before revisiting any of them.

| Metric | Value |
|---|---|
| Corpus | 172.5 MB, 51,069 lines, 22 project dirs |
| Top-level session files | 98 (98 MB) |
| Subagent transcripts | 340 files (75 MB) — 43% of corpus |
| Tool-result sidecars | 44 files (12 MB) |
| Base64 images | 45.0 MB (26%), 144 images, avg 305 KB |
| `toolUseResult` (duplicate of tool result content) | 31.6 MB (18%) |
| Thinking blocks | 16.2 MB (9%) |
| Per-line envelope overhead | 1,291 bytes/line, ~13 MB total |
| **Human prompts** | **3.1 MB (1.8%), 1,095 messages** |
| **Claude prose** | **2.9 MB (1.7%), 3,694 messages** |
| **Total searchable prose** | **5.8 MB — 3.5% of corpus** |
| Indexed prose records | 7,351 = 4,784 messages + 2,567 titles |
| Full cold extraction | **0.76 s** (~8 ms/file) |
| `stat` all 438 files | **< 1 ms** |
| Full in-memory AND query over those messages | **6–10 ms** |

Consequences:

- Extraction is not an optimization, it is the product. 172 MB collapses to 5.8 MB.
- A cold rebuild costs 0.76 s, so cache-invalidation cleverness is never warranted.
- A query costs < 16 ms, so filtering is synchronous per keystroke. No debounce.

## 3. Findings that constrain the design

These were discovered by reading the shipped extension bundle and the corpus.
Each one invalidates an otherwise-obvious implementation.

**F1 — Claude Code registers a URI handler.** Not declared in `package.json`
(it is a runtime `registerUriHandler` call), so it is invisible to inspection:

```
vscode://anthropic.claude-code/open?session=<uuid>&prompt=<text>
  -> executeCommand("claude-vscode.primaryEditor.open", session, prompt)
```

**F2 — Commands are directly callable** from a companion extension:
`claude-vscode.editor.open(sessionId, prompt, viewColumn)`.

**F3 — `createPanel` already reveals-if-open, new-tab-otherwise.** Passing a
`prompt` for an already-open session triggers a confusing "prompt was not
applied" toast, so always pass `prompt: undefined`. The `sessionPanels` map is
per-window; cross-window duplicates are unavoidable and harmless.

**F4 — There is no cwd parameter on the public command.** `spawnClaude` accepts
a cwd override internally, but it is unreachable. The panel's cwd is fixed at
construction from `workspaceFolders[0]`. We can only choose *which window*
resumes the session.

**F5 — Multi-root works better than expected.** `spawnClaude` passes *every*
workspace folder as `additionalDirectories`, so a session resumed in a multi-root
window can read and write across all folders.

**F6 — The project directory name is unreliable.** The sanitizer maps `/`, `.`
and `+` all to `-`, so it is lossy and irreversible. Worse, sessions move between
project dirs (manual recovery, `EnterWorktree`). Measured: **47% of sessions sit
in a directory whose name disagrees with their actual cwd**, and **78% record
more than one cwd** across their lifetime. The per-line `cwd` field is the only
source of truth; the directory name is a grouping hint only.

**F7 — VS Code's QuickPick applies its own fuzzy filter over `label`** on top of
supplied items. Since we match on content, that second filter would silently drop
correct results. Every emitted item must set `alwaysShow: true`.

**F8 — Remote/devcontainer URIs.** Folders are `vscode-remote://dev-container+.../...`.
Never mint a URI with `Uri.file()`; derive it from an existing workspace folder
URI so scheme and authority are preserved:
`workspaceFolders[0].uri.with({ path: session.cwd })`.

## 4. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Surface (MVP) | Quick Pick | fastest to build and use; more surfaces later |
| Packaging | single extension, `core/` module inside | smallest thing that supports future surfaces |
| Search scope | prose by default; tools via `!` fallback | prose is 3.5% of bytes and ~all of the signal |
| Freshness | cached index, refresh on invoke | ~25 ms typical; self-heals after resuming a session |
| Date window | default 7d, easily escaped | noise reduction, not a speed measure |
| Subagent prose | indexed, attributed to parent session | 43% of corpus; delegated work must be findable |
| License | MIT, public on GitHub | — |

## 5. Architecture

```
src/
  extension.ts          activate(): register commands only
  core/                 NO `vscode` import (enforced by eslint no-restricted-imports)
    types.ts
    discover.ts         walk ~/.claude/projects -> SourceFile[]
    extract.ts          .jsonl -> ProseMsg[] + SessionMeta
    index.ts            cache load/save, mtime-based refresh
    query.ts            filter -> match -> rank -> group
  surfaces/
    quickpick.ts        MVP surface
test/
  fixtures/             REDACTED COPIES OF REAL SESSIONS (see §9)
```

`core/` being `vscode`-free is what makes additional surfaces cheap and the
engine unit-testable without an extension host. If a CLI is ever wanted, `core/`
is promoted to its own package with a `git mv`.

## 6. Data model

```ts
interface SessionMeta {
  sessionId:  string;       // uuid; filename stem; passed to Claude Code
  file:       string;       // absolute path to the .jsonl
  projectDir: string;       // sanitized dir name — GROUPING HINT ONLY, never a path
  cwd:        string|null;  // LAST recorded cwd in the file (F6)
  cwdExists:  boolean;      // validated at index time
  title:      string|null;  // last ai-title record
  branches:   string[];     // distinct gitBranch values
  prLinks:    number[];     // from pr-link records
  firstTs:    number;       // from message timestamps, NOT file mtime
  lastTs:     number;
  msgCount:   number;
  mtimeMs:    number;       // cache-invalidation key
  size:       number;       // cache-invalidation key
}

interface ProseMsg {
  s: number;                     // index into sessions[]
  r: 'u' | 'a' | 't' | 'sub';    // your prompt | Claude | title | subagent
  t: number;                     // timestamp
  x: string;                     // the text
}
```

Rationale for the three non-obvious fields:

- `cwd` is the **last** recorded value, validated against disk — this is the F6 fix.
- `firstTs`/`lastTs` come from message timestamps, so the date window means "when
  we actually talked", surviving mtime-preserving file copies and long sessions.
- `prLinks` is first-class: the corpus holds 1,418 `pr-link` records and
  "which session made PR #N" is a primary use case.

## 7. Index and refresh

One JSON file in `context.globalStorageUri`, ~6 MB:

```jsonc
{ "v": 1, "builtAt": <epoch>, "sessions": [...], "prose": [...] }
```

`v` is a schema version; on mismatch discard and rebuild (0.76 s).

On each invoke: `stat` all source files (< 1 ms), compare `(mtimeMs, size)`,
re-extract only changed files (~8 ms each). Typical cost ~25 ms. A session
resumed a moment ago is picked up on the next search with no special handling.

**Tool content is deliberately not cached.** The `!` fallback live-scans the
date-filtered candidate files instead, keeping the cache at 6 MB rather than
170 MB and paying ~0.5 s only on the rare path.

## 8. Query, matching, ranking

Syntax — five things, no query language:

| Input | Meaning |
|---|---|
| `paste image` | all terms present, case-insensitive substring, AND |
| `"paste image"` | exact phrase |
| `pr:1234` | session that opened/touched that PR |
| `since:30d`, `since:all` | override the default window for this query |
| `!npm run build` | widen to tool calls and results (live scan) |

Scoring:

```
messageScore = matchQuality * roleWeight * recencyBoost

  matchQuality  exact phrase 3.0 | all terms within a 40-char span 2.0 | all terms present 1.0
  roleWeight    title 3.0 | your prompt 2.0 | Claude prose 1.0 | subagent 0.7
  recencyBoost  1 + 0.5 * exp(-ageDays / 14)

sessionScore = max(messageScores) + 0.3 * ln(1 + matchCount)
```

`pr:` and title matches short-circuit to the top. Your prompts outrank Claude's
replies because you remember what you asked, not what came back. Subagent prose
is discounted but present.

Row rendering (`QuickPickItem`, `alwaysShow: true` per F7):

```
label        ✻ Paste-image handling in the composer
description  acme-app · alex/paste-image-attach · 2d ago · PR #1234
detail       …I meant the image paste path, not the email one…   3 matches
```

Sessions with a missing cwd render `⚠ folder missing` and open read-only.

**Escaping the window without syntax.** When results are few or empty, pinned
`alwaysShow` rows are appended: `↻ Search all time — N sessions`, and when prose
returns nothing, `⌕ Search tool calls & results (slower)`. Never require the user
to remember syntax to escape an empty result. Default window is configurable via
`sessionFinder.defaultWindow` (default `7d`).

## 9. Opening a session

Resolve the session's `cwd` (last recorded, validated) against the current window:

```
cwd === workspaceFolders[0]              -> open here
cwd inside ANY workspace folder          -> open here          (F5)
cwd exists but outside the workspace     -> hand off           (below)
cwd missing on disk                      -> open transcript read-only
cwd never recorded                       -> open here, warn
```

"Open here" is a single call: `claude-vscode.editor.open(sessionId, undefined)`.
Reveal-if-open vs new-tab is Claude Code's own decision (F3); we do nothing.

Hand-off for genuinely foreign folders, via a filesystem baton:

```
1. write  <globalStorage>/pending-open.json
          { sessionId, targetCwd, expiresAt: now + 60_000 }
2. executeCommand('vscode.openFolder', targetUri, { forceNewWindow: true })
     targetUri built per F8, never Uri.file()
3. target window activate(): read pending-open.json
     expired?            -> delete, ignore
     targetCwd not ours? -> leave for another window
     ours                -> DELETE FIRST, then claude-vscode.editor.open(sessionId)
```

A file rather than `globalState` because mementos sync lazily between windows and
can race. Delete-before-open makes the baton single-use. The 60 s TTL prevents a
stale baton hijacking an unrelated window later.

**Assumption to verify empirically before building the hand-off:**
`openFolder` with `forceNewWindow: true` is expected to focus an existing window
when that folder is already open (VS Code identifies windows by workspace). The
whole hand-off leans on this.

Row actions:

| Action | Behavior |
|---|---|
| Enter | the decision tree above |
| Open transcript (button) | open the raw `.jsonl` transcript in an editor tab. Specified as Cmd/Ctrl+Enter; shipped as a row button because the Quick Pick API has no modifier-accept hook |
| Copy link (button) | `vscode://anthropic.claude-code/open?session=<id>` to clipboard |
| Reveal folder (button) | reveal the session's cwd in the explorer |

The copied link carries no cwd, so it resumes in whichever window handles it.
It is for durability and sharing; the Enter path is strictly more precise.

## 10. Error handling

- Claude Code command missing — `extensionDependencies` makes this near-impossible;
  catch the throw and offer the transcript view rather than surfacing a raw error.
- Session file deleted since indexing — caught at open time; drop from index, inform.
- `openFolder` cancelled — baton expires harmlessly.
- Corrupt or version-mismatched cache — discard, rebuild (0.76 s).
- Truncated final JSONL line (session being written) — skip the line, never throw.

## 11. Testing

| Layer | How | Pins down |
|---|---|---|
| `extract.ts` | fixture `.jsonl` | prose pulled, images/tool-results skipped, last cwd wins, title/PR/branch captured |
| `index.ts` | temp dir, mutated mtimes | changed re-extracted, unchanged skipped, version bump rebuilds |
| `query.ts` | synthetic corpus | phrase > terms, prompts outrank prose, `pr:` short-circuits, recency order |
| `surfaces/` | `@vscode/test-electron` | `alwaysShow` defeats the built-in filter (F7) |

Fixtures must be **redacted copies of real sessions**. Every surprise in this
design came from real data; none would appear in invented fixtures.

Three regression tests to write first, encoding the hardest-won findings:

1. A session whose directory name disagrees with its `cwd` resolves to the `cwd`.
2. A session with multiple `cwd` values resolves to the **last** one.
3. A subagent match is attributed to its **parent** session, and that session opens.

## 12. Publishing

The VS Code Marketplace has **no human review queue**. Publishing runs an
automated malware/secret scan and goes live in minutes. The gates are legal and
technical, not editorial.

One-time setup:

1. Azure DevOps organization at dev.azure.com (Marketplace uses it for identity).
2. Personal Access Token, scope **Marketplace → Manage**, organization
   **All accessible organizations**. A token scoped to a single org authenticates
   and then fails at publish — the classic mistake.
3. Publisher at marketplace.visualstudio.com/manage. The publisher ID is half the
   extension identity (`<publisher>.claude-code-session-finder`) and is **not renameable**.

Per release: `vsce login <publisher>` · `vsce package` · `vsce publish minor`.

Manifest essentials:

```jsonc
{
  "name": "claude-code-session-finder",
  "displayName": "Claude Code Session Finder",
  "publisher": "<tbd>",
  "license": "MIT",
  "extensionDependencies": ["anthropic.claude-code"],
  "activationEvents": [],        // commands activate lazily; NOT onStartupFinished
  "repository": { "type": "git", "url": "https://github.com/shobhitg/claude-code-session-finder" }
}
```

Also required in practice: `README.md` (it is the marketplace page), a 128x128
icon, a Quick Pick screenshot, and a `LICENSE` file. Bundle with esbuild before
publishing.

**Privacy statement is mandatory in the README.** This extension reads entire AI
conversation transcripts. State plainly: reads locally, indexes locally into
extension storage, sends nothing anywhere. That paragraph is what makes it
installable by people subject to security review.

Publish to **Open VSX** (`ovsx publish`) as well — that is what Cursor, Windsurf
and VSCodium install from.

Marketplace details above were written from knowledge with a training cutoff;
verify `vsce` flags and PAT scopes against live docs at publish time.

## 13. Out of scope (for now)

- Sidebar tree view and webview results panel — the `core/` boundary exists so
  these are additive later.
- SQLite FTS5 — correct at ~50x the current corpus size; overkill at 5.8 MB.
  Keep extraction separate from query so it can be swapped in without touching
  anything else.
- Filesystem watcher — buys ~25 ms over stat-and-compare and costs a class of
  partial-write concurrency bugs.
- CLI — revisit only if a second consumer of `core/` actually materializes.
- Pruning/compaction of old transcripts (images + `toolUseResult` are 76 MB of
  172 MB). Adjacent, useful, explicitly not this project.

## 14. Open questions

1. **Publisher ID** — must be created at marketplace.visualstudio.com/manage before
   the first publish, under the personal GitHub identity (shobhitg). Not renameable
   once chosen. `package.json` carries `<tbd>` until then.
2. **`openFolder` window de-duplication** (§9) — assumed, not verified. Verify
   before building the hand-off; if VS Code opens a duplicate window instead of
   focusing the existing one, the hand-off needs a different trigger.
3. **Extension ID collision** — check `claude-code-session-finder` is free on both
   the VS Code Marketplace and Open VSX before committing to the name.
