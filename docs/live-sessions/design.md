# Claude Code Sessions — Live Sessions & Browser — Design

> Written while the extension was still called *Claude Code Session Finder*; Stage 2 renamed it
> to **Claude Code Sessions** (the extension id did not change). Mentions of "Session Finder" below
> refer to this same extension.

**Status:** design for review, not yet implemented
**Date:** 2026-09-16
**Repo:** github.com/shobhitg/claude-code-session-finder (MIT, public)
**Supersedes nothing.** `docs/design.md` (v0.1, the search engine) stays the spec for
`core/discover → extract → cache → query` and for opening a session. This document adds a
live-state layer and a sidebar browser on top of that core. Findings here are numbered
**L1–L13** so they never collide with v0.1's **F1–F8**.

## 1. Problem

With a dozen Claude Code session tabs open, nothing in VS Code tells you which ones are
working, which finished and are waiting for you, and which are blocked. Every tab shows the
same icon. The only way to find out is to click through them.

The official extension does model this. Its webview computes a per-session state and pushes
it to the extension host:

```js
if (pendingPermissionRequests.length > 0) state = "waiting_input";
else if (busy || backgroundTaskIds.size > 0)  state = "running";
else                                          state = "idle";
updateSessionState(sessionId, state, summary, …)
```

but its tab-icon chooser only uses `running` to *suppress* the "done" badge:

```js
function chooseTabIcon(flags, anchor, deps) {
  if (flags?.hasPendingPermissions) return "pending";                     // blue dot
  if ((unread ?? flags?.hasUnseenCompletion) && anchor?.state !== "running") return "done";
  return "plain";                                                          // ← running lands here
}
```

Three icons — `pending`, `done`, `plain` — and "actively running" renders as `plain`,
identical to "idle with nothing to do". This extension cannot fix that (L1), so it puts the
signal in surfaces it owns, and while doing so becomes the one place that shows **live state
and content search together**: `softween.claude-code-session-monitor` has the former and no
search; v0.1 of this extension has the latter and no live state.

**Goal:** at a glance, see which sessions are running, which need you, and which are history —
and open any of them, in a tab or in the right-hand panel — from one sidebar list, with the
existing content search one keystroke away.

## 2. Measured baseline

All figures measured on the author's corpus on 2026-09-16 (v0.1's baseline was 2026-08-24 on a
smaller corpus). Re-measure before revisiting any decision that cites them.

| Metric | Value |
|---|---|
| Project dirs under `~/.claude/projects` | 41 |
| Top-level session transcripts | 167 |
| All `.jsonl` incl. subagents | 898 files, **0.7 GB**; median 319 KB, p90 1.2 MB, **max 21.8 MB** |
| `stat` every top-level transcript | **1.3 ms** |
| Seek + read a 64 KB tail + classify, **4 h active set** (33 files, 1.97 MB) | **5.5 ms** |
| Same, every top-level file (worst case, cold) | 1,029 ms — never done in steady state |
| Naive `tail -1` record type | `last-prompt` 71, `atis-latch` 20, `mode` 18, `pr-link` 13, `cost-state` 12, … — **0 of the top 12 types are conversational** |
| Sidecar (non-conversational) record types skipped over | `last-prompt` 149 · `artifact-autoreact-ledger` 61 · `atis-latch` 40 · `ai-title` 37 · `mode` 34 · `artifact-comment-monitor` 30 · `pr-link` 16 · `cost-state` 15 · `worktree-state` 10 · `relocated` 10 · `frame-link` 7 · `queue-operation` 4 · `agent-name` 3 · `custom-title` 1 |
| Last **conversational** record, all 167 | `assistant/end_turn` 138 · `user` 11 · `system/turn_duration` 11 · `system/local_command` 3 · `system/away_summary` 2 · `assistant/tool_use` 2 |
| Same, sessions untouched > 1 h (n=156) | `end_turn` 85.9% · `turn_duration` 6.4% · `user` 5.8% · `away_summary` 1.3% · `local_command` 0.6% · **`tool_use` 0%** |
| Same, sessions touched < 5 min (n=2) | **`tool_use` 100%** |
| Sessions with mtime within 2 h / 8 h / 24 h | 17 / 36 / 41 |
| 8 h set by state | 25 turn-ended · 10 in-flight-and-quiet · 1 in-flight-and-fresh |
| Quiet durations of the 10 in-flight-quiet | 130 s, then 43 min – 2.6 h (six `user` tails, all with text content) |
| Sidechain record as last conversational record | 0 |
| `session-monitor` (installed, polling ~20 s) at the same moment | `sessions=28 attention=18 working=10 ended=0` |
| Official extension `activate()` (`Ir0`) | 230 chars, **no `return`** — exports no API |
| Official extension contributed commands | 27; **none** approve/deny a permission request |

## 3. Findings that constrain the design

**L1 — The tab icon belongs to the official extension and cannot be changed from outside.**
It is set with `this.panelTab.iconPath = Uri.file(…)` on a `WebviewPanel` that
`anthropic.claude-code` owns. `vscode.window.tabGroups` exposes other extensions' tabs
read-only; there is no API to change another extension's tab icon or label. Every indicator
in this design lives in a surface this extension owns: a sidebar view, the status bar, and
the existing Quick Pick.

**L2 — The official extension exposes no session-state API and no permission command.**
`activate()` returns nothing (§2). Of its 27 commands, `acceptProposedDiff` /
`rejectProposedDiff` act on *file diffs*, not permission prompts. Consequences: liveness must
be **observed** from disk; the pending-permission state itself is invisible (it lives in the
webview's store and nothing is written until the prompt is answered); and "approve the prompt
from the browser" is impossible without Anthropic contributing a command (§15).

**L3 — The last line of a transcript is housekeeping, not state.** Claude Code appends
sidecar records (`last-prompt`, `atis-latch`, `mode`, `cost-state`, … — full list in §2) after
conversational ones. `tail -1` over the corpus found **zero** conversational records among the
twelve most common tail types. The classifier must walk backwards and skip every record whose
`type` is not `user`, `assistant` or `system`.

**L4 — The assistant's `stop_reason` separates the states totally, not statistically.**
Among 156 definitely-idle sessions, `end_turn` was the last conversational record in 85.9%
and `tool_use` in **0%**; among the fresh ones, `tool_use` in **100%**. `end_turn` means "the
model finished its turn and is waiting for you"; `tool_use` means "the model asked for a tool
and has not received the result". These two values *are* the state machine.

**L5 — Quiet is not blocked.** A model that is generating writes nothing to the transcript
until the message ends. The proof case was this design's own authoring session
(`6b2ede4f…`): last record `user` (a tool result), quiet for **130 s**, while the model was
producing a long reply. A "quiet ≥ 60 s ⇒ needs you" rule would have flagged the session that
was writing this sentence. The tail *type* must carry the distinction:

| Last conversational record | Quiet means | State |
|---|---|---|
| `assistant` · `stop_reason: tool_use` | a tool is running **or a permission prompt is showing** | attention after 60 s (`tool-or-permission`) |
| `assistant` · `tool_use` of `AskUserQuestion` or `ExitPlanMode` | Claude asked, or has a plan to approve | attention immediately (`question`) |
| `user` (prompt **or** tool_result) | the model is generating — normal for minutes | still running until 15 min, then `stalled` |
| `assistant` · `end_turn`, `system/turn_duration`, `system/away_summary`, `system/local_command` | the turn is over | attention immediately (`your-turn`) |

Labels must say what is known: "waiting on a tool or a permission prompt · 3 m", never
"blocked on permission".

**L6 — "Your turn" is only meaningful inside a recency gate.** 138 of 167 sessions end in
`end_turn` — of course they do; that is what a finished session looks like. Without a gate,
"Claude finished, your move" would light up months of history. The ACTIVE set is **sessions
whose effective mtime is within `sessionFinder.activeWindow`** (default `4h`; 33 sessions on
the author's corpus at measurement time); state is computed only inside it. Everything else
is HISTORY and carries no state.

**L7 — Subagent activity does not touch the parent's mtime.** Subagent transcripts are
separate files under `<projectDir>/<sessionId>/subagents/**`. A session running a five-minute
subagent has a stale main file. **Effective mtime = max over the main file and every
subagent file** (`discover()` already returns both, attributed to the parent).

**L8 — Duplicate main copies exist after worktree moves** (v0.1 finding C2: the same
`sessionId` in two project dirs). The old copy is never written again. Liveness reads the tail
of the **most recently modified main copy** and ignores the other; subagent files never
supply the verdict, only the mtime (L7). Liveness works from `discover()`'s `SourceFile.kind`,
never from paths, so the `subagents/` convention keeps its single definition in `discover.ts`.

**L9 — The corpus forbids full reads in the live path.** 0.7 GB total, 21.8 MB maximum. The
live path may only `stat`, and only `seek()`-and-read a **64 KB** tail (widened once to
512 KB if no conversational record is found). `refreshIndex()` — which reads whole files and
rewrites the cache — runs on its own slow cadence (§8), never per tick.

**L10 — `claude-vscode.editor.open` has a hidden side effect, and a flag that avoids it.**
Routing, de-minified:

```js
function route({ programmatic, preferredLocation, sessionAlreadyOpenInPanel, fullEditor }) {
  if (programmatic)
    return { target: programmatic === "honor-preferred-location" && preferredLocation === "sidebar"
                     && !sessionAlreadyOpenInPanel ? "sidebar" : "panel",
             updatePreferredLocationToPanel: false };
  return { target: "panel", updatePreferredLocationToPanel: !fullEditor };   // ← non-programmatic
}
// editor.open(sessionId, prompt, _, _, fullEditor, options)  →  route({ programmatic: options?.programmatic, … })
```

v0.1 calls `editor.open(id, undefined)` — non-programmatic — so **every Session Finder open
resets the user's Claude Code preferred location to "panel"**. Passing
`{ programmatic: true }` as the sixth argument removes the side effect and keeps panel
targeting. Opening in the right-hand panel is `claude-vscode.sidebar.open` (which sets the
preferred location to `sidebar` — a persistent, user-visible mode, and shows a warning when
the secondary sidebar is unsupported) followed by
`editor.open(id, undefined, undefined, undefined, undefined, { programmatic: "honor-preferred-location" })`.
Older extension versions ignore the sixth argument, so passing it is forward-compatible.

**L11 — A `TreeView` cannot host a design system.** A `TreeItem` is `label`, `description`,
`tooltip`, `iconPath`; no layout, type scale, spacing or multi-line rows. A **webview view**
in a sidebar container is the pattern both `anthropic.claude-code` and `session-monitor` use.
It costs hand-rolled keyboard navigation and loses free virtualization — acceptable because
HISTORY renders 50 rows and delegates to the Quick Pick for everything else. Theme adherence
comes from VS Code's `--vscode-*` CSS variables; icon parity from the codicon font
(`@vscode/codicons`), whose `codicon-modifier-spin` is the IDE's own spinner.

**L12 — Renamed sessions show a stale title.** Claude Code writes a
`{ "type": "custom-title", "customTitle": "…", "sessionId": "…" }` record when the user renames a
tab (`claude-vscode.renameSessionTab`). `extract.ts` reads only `ai-title`. Titles must prefer
the latest `custom-title`, falling back to the latest `ai-title`. This changes indexed output,
so `INDEX_VERSION` bumps 1 → 2 (a full re-extract, ~1.6 s cold — v0.1: "never be clever").

**L13 — Every VS Code window runs its own poller, and that is fine.** The corpus is global
(`~/.claude/projects`), so each window independently computes the same answer. Per-window
cost is ~1.3 ms of `stat` per sweep and ~5 ms of tail reads per tick *only for files whose
mtime changed*. Sharing state across windows would add a file protocol for no measurable
saving. Not doing it.

## 4. Decisions

| # | Decision | Because |
|---|---|---|
| D1 | **Fold into this extension**; no second extension. `displayName` → "Claude Code Sessions", `description`/`keywords` updated. **`name` and `publisher` never change** (they are the extension ID; changing them orphans every install). | One index, one crawler, one storage; `surfaces/` was already plural. Two extensions would both crawl 0.7 GB and drift. |
| D2 | Liveness is **observed from transcript tails**. No hooks, no `settings.json` writes, no process inspection. | L2; zero onboarding friction for marketplace users; works for CLI sessions too. |
| D3 | Three surfaces over one core: a **webview view** ("Sessions") in an activity-bar container, a **status bar item**, and state icons in the **existing Quick Pick**. | L1, L11. |
| D4 | **Extension host owns all state; the webview is a renderer** of full snapshots. `retainContextWhenHidden: false`. | Cheap when hidden; trivially re-renderable; the state lives where the timers are. |
| D5 | State vocabulary and thresholds as in §7. Thresholds are settings: `sessionFinder.activeWindow` `"4h"`, `sessionFinder.toolQuietSeconds` `60`, `sessionFinder.stalledMinutes` `15`. | L5, L6. Users with long test suites will want a longer tool threshold. |
| D6 | Scheduler cadences (§8): **sweep 10 s**, **tick 2 s**, both **paused while the window is unfocused**; **index refresh** only when ACTIVE membership changes, when the view becomes visible, or every 60 s while visible. | L9, L13. |
| D7 | Design system = **semantic tokens aliased to `--vscode-*` variables**; the only invented values are spacing, radius and motion; **no hex literals**; icons are codicons by name. | "Beautiful" and "theme-first" stop conflicting when the theme supplies the palette. |
| D8 | Ship in **two stages**: Stage 1 = engine + status bar + Quick Pick icons + the L10 fix (**0.2.0**); Stage 2 = webview browser + right-panel open + `custom-title` (**0.3.0**). | Stage 1 answers the original question in days and proves the classifier on real use before the UI is built on it. |
| D9 | The browser has **no search box**. HISTORY shows the 50 most recent sessions and a "Search all N sessions…" row that opens the Quick Pick. | `Ctrl+Alt+S` is already the best content-search surface; a second one would compete with it. |
| D10 | **No telemetry, no network.** Unchanged from v0.1. | Privacy stance is part of the marketplace listing. |
| D12 | **An open Claude Code tab pins its session ACTIVE** past `activeWindow` (`LivenessTracker.setPinned`, fed by the sidebar's tab → session resolution), and such a row wears a standing "> N hours old" tag; only tabless sessions age out. | With the × closing tabs, a session listed under Closed while its tab was open contradicted itself. The user closes old tabs on purpose; the list does not decide for them. |
| D13 | **The bell rings while the ball is in your court and you have not seen it there** (`core/looks.ts`). A question — `AskUserQuestion`, or a plan waiting for approval (`ExitPlanMode`) — rings until Claude moves again. Your turn, an interruption and a quiet tool call ring until you *look*: the session's Claude Code tab is the visible tab of an editor group, or its Session View is visible, in a focused window, while it waits on you. Running and stalled never ring. The status bar counts ringing sessions only; a ringing row wears the needs-you look (accent bar, semibold). Looks live in `globalStorage/looks.json`, shared by every window: merged on write, and re-read before every snapshot in the focused window (the only one that records looks); a first run starts them "now". Two windows writing in the same instant can overwrite each other's newest look; the loser rewrites it with its next save. | 0.7.0 kept every open tab ACTIVE, and they all counted as "need you": the count stood at nine with nothing waiting. What needs you is what you have not acknowledged — except a question, which is not answered by being read. A permission prompt cannot be told from a long command (L4), so a quiet tool call clears on a look rather than staying sticky: a long build rings at most once. |
| D11 | **HISTORY is labelled "Closed", and an ACTIVE row can be closed** (§9.1): a marker keeps the session out of liveness until its transcript is written again after the close, and its Claude Code tab is closed with it. | Resuming writes the transcript, so one click under HISTORY promoted a finished session to ACTIVE with no way back. Closing the tab is what "done with this" means, and Claude Code's own vocabulary is "closed session"; "Archive" would imply deliberate filing for rows that merely aged out. |

## 5. Architecture

```
src/
  core/                              vscode-free (eslint no-restricted-imports, unchanged)
    discover.ts     (v0.1)  unchanged — SourceFile.kind is the subagent signal (L7, L8)
    extract.ts      (v0.1)  + custom-title precedence               (L12)                  Stage 2
    types.ts        (v0.1)  INDEX_VERSION 1 → 2                                             Stage 2
    query.ts        (v0.1)  'h' unit; + durationMs(spec, fallback)  (activeWindow parsing)  Stage 1
    state.ts        NEW     classifyTail · resolveState · pickMainFile · effectiveMtime  (pure, node-free)
    tail-io.ts      NEW     readTail · readVerdict (node:fs) — split out so state.ts can be bundled into the webviews
    live.ts         NEW     LivenessTracker: sweep/tick over injected discover/stat/readVerdict/clock; emits diffs
    rows.ts         NEW     buildSnapshot(index, liveness, opts) → Snapshot; stateIcon(); projectLabel()  (pure)
    open-args.ts    NEW     openCommands(sessionId, where) → the exact command calls (L10)  (pure planner, like resolve.ts)
  surfaces/
    quickpick.ts    (v0.1)  + state icon prefix on rows                                     Stage 1
    statusbar.ts    NEW     "$(loading~spin) 1  $(bell-dot) 3", click → sessions             Stage 1
    live-view.ts    NEW     WebviewViewProvider; snapshot → postMessage; message handler     Stage 2
  webview/
    model.ts        NEW     pure view-model (labels, icon classes) — testable in node          Stage 2
    main.ts         NEW     DOM glue: render view-model, keyboard nav, post actions (`/// <reference lib="dom" />`)  Stage 2
    style.css       NEW     tokens + components (§10)                                        Stage 2
  live-host.ts      NEW     vscode glue: settings → tracker; focus pause; index cadence; emits Snapshot   Stage 1
  open.ts           (v0.1)  executePlan(plan, ctx, where) runs openCommands(); baton carries `where` (L10)
  baton.ts          (v0.1)  Baton gains optional `where`                                      Stage 2
  extension.ts      (v0.1)  wires LiveHost, status bar, view, commands
resources/
  sessions.svg      NEW     monochrome activity-bar icon
esbuild.mjs                 two entry points; copies codicon.css/.ttf → dist/codicons/
package.json                viewsContainers · views · commands · menus · configuration · version
```

Data flow:

```
disk (~/.claude/projects)
  │ stat (sweep, 10 s)              │ seek+64 KB read (tick, 2 s, changed files only)
  ▼                                 ▼
core/live.ts  LivenessTracker  ──► Map<sessionId, Liveness>  ──onChange──►  extension.ts
                                                                              │
core/cache.ts refreshIndex() ──► SearchIndex (titles, cwd, branches, PRs)      │
                                       │                                      │
                                       └──────► core/rows.ts buildSnapshot ◄──┘
                                                          │
                       ┌──────────────────────┬───────────┴───────────┐
                       ▼                      ▼                       ▼
              surfaces/statusbar.ts   surfaces/live-view.ts     surfaces/quickpick.ts
                                        │ postMessage(snapshot)
                                        ▼
                                   webview/main.ts  ──postMessage(action)──►  open.ts
```

## 6. Data model

`SessionMeta` and the persisted index are **unchanged in shape**. Liveness is never persisted:
it changes every few seconds and is recomputed from tails.

```ts
// core/state.ts
/** What the last conversational record says, independent of time. */
export type TailVerdict =
  | 'turn-ended'       // assistant.stop_reason === 'end_turn' | system.subtype ∈ {turn_duration, away_summary, local_command}
  | 'awaiting-tool'    // assistant.stop_reason === 'tool_use'  — a tool is running, or a permission prompt is showing
  | 'awaiting-model'   // user (a prompt or a tool_result was appended; the model has not written since)
  | 'unknown';         // no conversational record in the window, or nothing parseable

export type AttentionReason = 'tool-or-permission' | 'your-turn' | 'stalled';
export type LiveState =
  | { kind: 'running' }
  | { kind: 'attention'; reason: AttentionReason };

export interface Thresholds { toolQuietMs: number; stalledMs: number }   // defaults 60_000, 900_000

export interface Liveness {
  sessionId: string;
  verdict: TailVerdict;
  state: LiveState;
  /** max mtime over the main copy(ies) AND subagent files (L7) */
  lastWriteMs: number;
}
```

```ts
// core/rows.ts — what surfaces render; plain data, serialisable to the webview
export interface LiveRow {
  sessionId: string; title: string; project: string; branch: string | null; pr: number | null;
  cwdExists: boolean;
  state: 'running' | 'attention'; reason?: AttentionReason;
  lastWriteMs: number;              // the view renders "quiet 2m" from this and its own clock
  parked?: true;                    // quiet past the window, ACTIVE only because its tab is open (D12)
  ringing?: true;                   // the bell (D13): the ball is in your court and you have not seen it
}
export interface HistoryRow {
  sessionId: string; title: string; project: string; branch: string | null; pr: number | null;
  cwdExists: boolean; lastTs: number; msgCount: number;
}
export interface Snapshot { active: LiveRow[]; history: HistoryRow[]; totalSessions: number; indexing: boolean }
```

Ordering inside ACTIVE (D5 rationale: things that need you first, then things that are
working, then things that are probably dead): `attention/question` → `attention/tool-or-permission` →
`attention/your-turn` → `attention/interrupted` → `running` → `attention/stalled` → **parked**; within
a group, `lastWriteMs` descending. Parked (0.8.0) is every session quiet past the window and kept only
by its tab, whatever its state: before it had its own group, a tab left open since yesterday ranked as
"your turn" above every running session, so a session you had just started or resumed was listed under
a wall of day-old ones. HISTORY: `lastTs` descending, excluding ACTIVE session ids, first 50.

The webview then keeps rows still (`stableOrder`): within a group they are ordered by **arrival in that
group**, newest on top (`noteArrivals` stamps a row when it is new to ACTIVE, back in it, or in a new
state), so a row never moves because it wrote, and a session you just started, resumed, or that just
finished is the first of its kind. Parked rows keep the host's order — nothing in there writes. Until
0.8.0 the stamp was first sight only, so a resumed session went back to the slot it had days before.

`Baton` gains `where?: 'tab' | 'right'` so a cross-window hand-off preserves the requested
target. Absent means `'tab'`; a baton written by v0.1 still parses.

## 7. Liveness engine (`core/state.ts`)

**Inputs:** a main-copy transcript path, its size, the set of files attributed to the session
(from `discover()`), a clock. **No `vscode`, no timers.**

```
pickMainFile(files)        the SourceFile with kind 'session' and the greatest mtimeMs           (L8)
effectiveMtime(files)      max mtimeMs over ALL files, sessions and subagents alike               (L7)
readTail(path, size)       seek to max(0, size − 65536), read to EOF; if size > 65536 drop the first
                           (partial) line; decode UTF-8 with replacement                          (L9)
classifyTail(text)         walk lines backwards; skip records whose type ∉ {user, assistant, system}
                           and records with isSidechain === true; return the first verdict:
                             assistant  → stop_reason 'end_turn' → turn-ended
                                          stop_reason 'tool_use' → awaiting-tool
                                          anything else          → awaiting-model   (rare: max_tokens etc.)
                             system     → subtype ∈ {turn_duration, away_summary, local_command} → turn-ended
                                          otherwise skip (not a turn boundary)
                             user       → awaiting-model
                           none found → unknown
                           unparseable line → skip (a truncated write in progress is normal)
resolveState(verdict, quietMs, thresholds)
                             turn-ended                              → attention / your-turn
                             awaiting-tool  · quiet <  toolQuietMs   → running
                             awaiting-tool  · quiet ≥  toolQuietMs   → attention / tool-or-permission
                             awaiting-model · quiet <  stalledMs     → running                    (L5)
                             awaiting-model · quiet ≥  stalledMs     → attention / stalled
                             unknown                                 → caller widens the window: 64 KB →
                                                                       512 KB → 2 MB → whole file. Still
                                                                       unknown → shown like awaiting-model
```

`quietMs = now − effectiveMtime`. Note `turn-ended` ignores quiet time: the sidecars written
after `end_turn` keep mtime fresh for a moment, and "your turn" is true regardless.

**What this cannot see, stated in the UI:** whether an `awaiting-tool` quiet is a permission
prompt or a slow tool. The row reads *"waiting on a tool or a permission prompt · 3 m"*.

## 8. Scheduler (`core/live.ts`)

`LivenessTracker` is a pure state machine over injected `fs` (`readdir`, `stat`, `open/read`)
and `now()`, so vitest drives it with fake timers and an in-memory tree. It exposes
`sweep()`, `tick()`, `start()/stop()`, and `onChange(cb)`, and fires `onChange` **only when the
computed map differs** from the last one in membership, verdict, state, reason or
`lastWriteMs`. A running session that appends therefore re-publishes (a few KB every 2 s, so
its "quiet 40 s" label is never stale); an idle ACTIVE set publishes nothing, and the view's
own clock advances the labels between snapshots.

| Phase | Cadence | Work | Budget (measured §2) |
|---|---|---|---|
| **sweep** | every 10 s; immediately on `start()`, window focus, view visible | `discover()` — readdir + stat everything; recompute ACTIVE membership (effective mtime within window) | ~1.3 ms for 167 top-level files |
| **tick** | every 2 s | for ACTIVE sessions whose main-copy `(mtimeMs, size)` changed since last tick: `readTail` + `classifyTail`; for all ACTIVE: `resolveState` with the current clock (a session can cross a threshold without any I/O) | ≤ 5.5 ms even if every active file changed |
| **index refresh** | when ACTIVE membership changes (a session appeared/left), when the view becomes visible, and every 60 s while it is visible | `refreshIndex()` — whole-file reads of *changed* files only (cache key `(mtimeMs, size)` unchanged from v0.1), rewrite of `index.json` | ~1.6 s cold, tens of ms warm; never per tick (L9) |
| **paused** | `window.state.focused === false` | nothing; the first focus event runs a sweep + tick, so the status bar is correct within one tick of coming back | 0 |

A brand-new session (id not in the index yet) shows its id prefix as the title until the
membership-change refresh lands (≤ 2 s later). Deleted transcripts drop out on the next sweep.

## 9. Surfaces

### 9.1 Sidebar browser (`surfaces/live-view.ts` + `webview/`) — Stage 2

A `WebviewViewProvider` registered for view `sessionFinder.live` inside a new activity-bar
container `sessionFinder` (icon `resources/sessions.svg`). It lives in the **primary** sidebar
by default so that "open in right panel" (§11) has somewhere to go; VS Code lets the user drag
it elsewhere without code.

Protocol (all messages are plain JSON; unknown `type`s are ignored):

| Direction | Message |
|---|---|
| view → host | `{ type: 'ready' }` on load — host answers with a snapshot |
| host → view | `{ type: 'snapshot', snapshot: Snapshot, now: number }` |
| view → host | `{ type: 'open', sessionId, where: 'tab' \| 'right' }` · `{ type: 'transcript', sessionId }` · `{ type: 'copyLink', sessionId }` · `{ type: 'reveal', sessionId }` · `{ type: 'close', sessionId }` · `{ type: 'search' }` |

The webview persists only UI state (collapsed sections) via `vscode.getState()/setState()`.
CSP: `default-src 'none'; style-src ${cspSource}; font-src ${cspSource}; script-src 'nonce-…'`;
`localResourceRoots: [dist/]`.

Layout:

```
┌ SESSIONS ─────────────────────────────────────── ↻  🔍 ┐   view/title: refresh, search (→ Quick Pick)
│ ACTIVE                                            4      │   section header · count badge · chevron
│ ▸ ◔ Ledger GUI for LLM usage                   quiet 3 m │   tool-or-permission: accent bar, semibold
│     aida · shobhit/ledger · PR #20231                    │
│ ▸ ↩ Deal forecast feature                      3 m ago   │   your-turn: normal weight
│     aida · main                                          │
│ ▸ ⟳ Slack thread discussion                    just now  │   running: spinner (codicon-loading spin)
│     aida · shobhit/slack-thread                          │
│ ▸ ⚠ Ant and Ian reporting                      2.1 h     │   stalled: dimmed
│ CLOSED                                            163    │   HISTORY in the data model (D11)
│   ◷ Sequencing triage briefs        Sep 15 · 31 msgs     │
│   ◷ Figma skill                     Sep 14 · 88 msgs     │
│   …                                                      │
│   🔍 Search all 167 sessions…            Ctrl+Alt+S      │   → sessionFinder.search
└──────────────────────────────────────────────────────────┘
   hover / focus on a row reveals actions:  ▤ view   ▥ right panel   ⎘ link   {} transcript   × close (ACTIVE rows)
```

Keyboard: the list is a roving-tabindex `listbox`; `↑/↓` move, `Enter` opens in a tab,
`Shift+Enter` opens in the right panel, `T` transcript, `V` Session View, `Delete` closes, `/` opens
the Quick Pick, `Esc` clears focus. Focus ring is `1px solid var(--s-focus)`, inset. These are plain
keys only: a Cmd/Ctrl/Alt chord, and anything typed into the filter, is left alone. **No webview keydown
handler may stop propagation** (`webview-keys.test.ts`): VS Code's webview host listens on the window and
performs Cmd+V, Cmd+A and Cmd+Z for the webview itself, blocking the browser's own clipboard keys on desktop,
so a key that never reaches the window does nothing (0.8.0: paste was dead in the filter on macOS).

**Closing a session (D11, `core/closed.ts`).** Resuming a session writes its transcript, so a click
under CLOSED promotes the session to ACTIVE for the whole `activeWindow`. The `×` on an ACTIVE row
(also `Delete`, and `sessionFinder.closeSession`) records a marker — session id → the moment of the
close — in `globalState`, and the host leaves a marked session out of the liveness every surface
reads while nothing has written its transcript after the close. Claude Code shuts a session down
when its tab closes and may write once more on the way out, so writes within a 10 s grace do not
count; anything later (the user resumed it and sent a message) is real activity, and the marker
goes. Opening a closed session from here drops the marker at once. The view then closes every
Claude Code tab whose label the sidebar resolves to that session — the same label → id resolution
the highlight uses — so the row moves as the tab goes. A session Claude is still working in
(`running`) asks first, because closing the tab stops it. Tabs carry no session id, only a label —
the title cut to 24 characters plus "…" — so identification is by rules in `rows.ts`:
`labelMatchesTitle` reads the ellipsis as a proper prefix (Claude Code's own matcher does the same);
a label is *learned* for a session only when its tab was not there before our own open and it can be
that session's title (the first tab event after an open reports the previously active tab); a learned
label is trusted only while it fits the session's title; and `tabsToClose` closes a tab only when it
can be nobody else's — its label is on no other open tab and exactly one known session fits it.
Otherwise the tab stays open and a message says so: a wrongly closed tab stops somebody else's session.
The other direction uses the same rules with a lighter hand, since a marker is not destructive: a
Claude Code tab closed by hand (`onDidChangeTabs` → `closed`) marks its session closed when its label is
a trusted learned one or fits exactly one known session; an ambiguous label on the tab that was active
takes the highlight's resolution; an ambiguous background tab changes nothing. Its learned label is
forgotten with it. Our own Session View panels are not session tabs.

**Pinned by a tab (D12).** `pinnedSessions` maps the open Claude Code tabs to sessions with the same
candidate rules (an ambiguous label → the most recently written candidate) and the host hands the set to
the tracker, whose sweep keeps a pinned session whatever its age. The row is an ordinary live row —
verdict, glyph, time label — marked `parked` by the tracker, which sorts it below everything live (§6),
plus an age tag (`ageTag`, model.ts) once `now − lastWriteMs` exceeds the
window: "> 19h" (whole hours, then days and hours: "> 2d 1h"), a filled orange pill, red after a day, at the right end of
line 2 just before the cost meter, standing in for the time label it would duplicate (the tooltip keeps
that label). Pins are recomputed
on every tab change and every snapshot, and a pinned session's closed marker is dropped (`applyClosed`).

**Activity is the conversation, not the file (0.7.1).** Resuming or merely viewing a session appends
sidecars (`cost-state`, `mode`, `last-prompt`, `atis-latch`) and moves the transcript's mtime — measured
on real transcripts: files touched minutes ago whose last message was 18–23 h earlier. `readTailInfo`
therefore also returns `lastTs`, the verdict record's own timestamp, and the tracker's `lastWriteMs` is
that (or a newer subagent mtime, L7); mtime remains only the sweep's cheap pre-filter, and `publish` judges
the window by `lastWriteMs` too, so a glanced-at session is neither "just now" nor ACTIVE. A right-panel session has no tab: only
the marker applies. Markers are pruned when their session is written past the grace or when they
are older than `activeWindow` + grace.

Empty and loading states: ACTIVE empty → *"Nothing running. Sessions touched in the last 4 h
appear here."* HISTORY while the cold index builds → three skeleton rows; `indexing: true` in
the snapshot drives this.

### 9.2 Status bar (`surfaces/statusbar.ts`) — Stage 1

Left-aligned item, text `$(loading~spin) 1 · $(bell-dot) 3` (running count, and the sessions that
ring — D13 — not every session that waits; a zero count omits its segment), tooltip lists the
sessions, ringing ones first and bold, click runs `sessionFinder.live.focus` (Stage 1, before the
view exists: runs the Quick Pick). Hidden when nothing runs and nothing rings (until 0.8.0: when
ACTIVE was empty).

### 9.3 Quick Pick (`surfaces/quickpick.ts`) — Stage 1

Rows already start with `$(sparkle)`. Replace the glyph by state: `$(loading~spin)` running,
`$(bell-dot)` tool-or-permission, `$(comment-discussion)` your-turn, `$(warning)` stalled,
`$(sparkle)` history. Codicon syntax in `QuickPickItem.label` is documented API; `~spin` is the
documented animation modifier (29 `$(loading~spin)` usages across the author's installed
extensions).

## 10. Design system

**Rule: the stylesheet contains no hex literal.** Every colour resolves through a `--vscode-*`
variable, so the view is correct in the user's theme, Light+, High Contrast, and themes that do
not exist yet. The only values this extension invents are rhythm and motion.

```css
:root {
  /* surface — inherited, never invented */
  --s-bg:        var(--vscode-sideBar-background);
  --s-fg:        var(--vscode-sideBar-foreground, var(--vscode-foreground));
  --s-muted:     var(--vscode-descriptionForeground);
  --s-hover:     var(--vscode-list-hoverBackground);
  --s-sel:       var(--vscode-list-activeSelectionBackground);
  --s-sel-fg:    var(--vscode-list-activeSelectionForeground, var(--s-fg));
  --s-focus:     var(--vscode-focusBorder);
  --s-header-fg: var(--vscode-sideBarSectionHeader-foreground, var(--s-fg));
  --s-badge-bg:  var(--vscode-badge-background);
  --s-badge-fg:  var(--vscode-badge-foreground);
  --s-skeleton:  var(--vscode-editorWidget-background);

  /* state — mapped onto the theme's own semantic ramp */
  --st-running:  var(--vscode-charts-blue);
  --st-needs:    var(--vscode-charts-yellow);
  --st-stalled:  var(--vscode-editorWarning-foreground);
  --st-idle:     var(--vscode-descriptionForeground);

  /* type — the IDE's */
  --font:  var(--vscode-font-family);
  --size:  var(--vscode-font-size);          /* 13px by default */
  --size-meta: calc(var(--vscode-font-size) - 2px);
  --mono:  var(--vscode-editor-font-family);

  /* rhythm — the ONLY primitives we invent */
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px;
  --radius: 4px;
  --row: 44px;                 /* two lines of 22px — VS Code's list row height, doubled */
  --dur: 120ms; --ease: cubic-bezier(.2, 0, .2, 1);
}
@media (prefers-reduced-motion: reduce) { :root { --dur: 0ms; } }
```

**Icons** are codicons by name, loaded from the bundled `@vscode/codicons` font
(`dist/codicons/codicon.css` + `.ttf`). Same family as the explorer, SCM view and Claude Code's
own chrome. The running spinner is `codicon-loading codicon-modifier-spin` — literally the
IDE's spinner. Under reduced motion it becomes a static `codicon-circle-large-filled` in
`--st-running`.

**State visual language:**

| State | Icon | Colour | Title weight | Row | Time label |
|---|---|---|---|---|---|
| running | `loading` (spin) | `--st-running` | 400 | — | "just now" / "quiet 1m" |
| attention · tool-or-permission | `bell-dot` | `--st-needs` | 400 | — | "quiet 3m" |
| any state that **rings** (D13) | — | — | 600 | 2 px left accent in `--st-needs` | — |
| attention · your-turn | `comment-discussion` | `--s-fg` | 400 | — | "done · 3m ago" |
| attention · stalled | `warning` | `--st-stalled` | 400 | opacity .7 | "2h 6m" |
| history (labelled Closed) | `history` | `--st-idle` | 400 | — | "Sep 15 · 31 msgs" |
| folder missing | suffix `⚠ folder missing` in `--s-muted` (v0.1 wording) | | | | |

**Section headers** follow VS Code: uppercase, `--size-meta`, letter-spacing .04em,
`--s-header-fg`, a chevron codicon, and a count in a `--s-badge-*` pill.

**Row anatomy:** icon column 16 px + `--sp-2`; line 1 = title (ellipsis) + right-aligned time in
`--mono` with `font-variant-numeric: tabular-nums` (empty on an old row); line 2 = `project · branch ·
PR #n` in `--s-muted` at `--size-meta`, then the age tag, then the cost meter. Line 1 ends with the action cluster's own spot,
the × in the row's top-right corner; the actions are laid out always and only made visible on hover
and on focus (keyboard users must not need a mouse), so nothing moves under the pointer (0.7.2). Below
a 380 px sidebar (a container query) the slot cannot be spared beside the title and the actions take
the time's place on hover instead.

**Motion:** hover background and accent fade over `--dur`; a row entering ACTIVE fades in over
`--dur`; state changes crossfade the icon. Nothing moves that the user did not cause except
the spinner.

## 11. Opening a session (`open.ts`)

`core/open-args.ts` is a pure planner in the style of `resolve.ts`: `openCommands(sessionId,
where)` returns the exact `{ command, args }` calls to execute, so the argument positions
(L10, F3) are unit-tested and `open.ts` only loops over them.
`executePlan(plan, ctx, where: 'tab' | 'right' = 'tab')`:

| plan.kind | where = tab | where = right |
|---|---|---|
| `here` | `editor.open(id, undefined, undefined, undefined, undefined, { programmatic: true })` — **fixes the L10 side effect for every existing caller** | `sidebar.open` then `editor.open(id, undefined, undefined, undefined, undefined, { programmatic: 'honor-preferred-location' })` |
| `handoff` | baton `{ …, where: 'tab' }` → other window opens as above | baton `{ …, where: 'right' }` |
| `transcript` | unchanged (v0.1 §9/§10) | same |

`sidebar.open` changes a persistent Claude Code preference (future opens go to the sidebar
until the user changes it back). The first time the user chooses "right panel", a one-time
information message says so. When the running VS Code lacks a secondary sidebar, Claude Code
shows its own warning and opens in the activity-bar sidebar instead; nothing to handle here.

## 12. Error handling

- Any `fs` error inside a tick or sweep drops that file for that cycle and logs once per path
  to an output channel "Claude Code Sessions"; the tracker **never throws** out of a timer.
- A partially written last line is normal (Claude Code appends while we read): skipped, not
  logged.
- A snapshot whose session vanished between render and click: the host re-checks
  `existsSync(file)` before opening (v0.1 §10) and refreshes the view.
- Unknown webview messages are ignored; every field the host reads from a message is
  type-checked before use.
- Command failures surface the v0.1 toast with the "Open transcript" fallback.

## 13. Testing

**Unit (vitest, `test/*.test.ts`, no fixtures needed — inline JSONL strings as in
`cache.test.ts`'s `sessionLine` helper):**

- `state.test.ts` — `classifyTail`: sidecars skipped (L3); each verdict; sidechain skipped;
  `system` non-boundary subtypes skipped; unparseable line skipped; empty → `unknown`.
  `resolveState`: every row of the §7 table, both sides of both thresholds. `pickMainFile`
  and `effectiveMtime` with subagent files newer than the main file (L7) and with two main
  copies (L8). `readTail` drops the partial first line only when truncated.
- `live.test.ts` — tracker with fake `fs` + clock: sweep gates by window; tick reads only
  changed files (assert on the fake's read count); a threshold crossing with no I/O fires
  `onChange`; identical recomputation does **not** fire; `stop()` cancels timers.
- `closed.test.ts` — the close marker (D11): holds through the grace, expires on a later write, pruned past the window.
- `rows.test.ts` — ordering, HISTORY exclusion of active ids, the 50 cap, id-prefix title for
  an unindexed session, `indexing` flag.
- `open-args.test.ts` — the exact command/argument arrays for `tab` and `right` (L10): the
  sixth argument is present, `prompt` is `undefined` (F3).
- `extract.test.ts` — `custom-title` beats `ai-title`; latest `custom-title` wins.
- `window.test.ts` — `durationMs('4h')`; `since:2h` in a query.
- `baton.test.ts` — `where` round-trips; a v0.1 baton without `where` still claims.
- `webview-model.test.ts` — time labels ("just now", "quiet 3m", "2h 6m", "Sep 15 · 31 msgs"),
  icon class and weight per state, section counts.

**Extension host (`test-e2e`, existing `@vscode/test-electron` harness):** the harness runs
with `--disable-extensions`, which disables `anthropic.claude-code`, and `extensionDependencies`
therefore keeps *this* extension from activating in that run (see the comment in
`test-e2e/suite/quickpick.test.ts` — do not "fix" it). The e2e test asserts on the installed
manifest, as v0.1 does: the `sessionFinder` view container and `sessionFinder.live` view, the
`sessionFinder.showSessions` / `openInTab` / `openInRightPanel` / `refresh` commands, and the
three `sessionFinder.*` configuration keys with their defaults. Behaviour is covered by the
unit tests above plus the manual QA below.

**Manual QA before each stage ships (recorded in the PR):** counts vs `session-monitor` on the
same corpus at the same minute; a session mid-generation stays *running* past 60 s (L5); a
real permission prompt shows *tool-or-permission* at 60 s; light, dark and high-contrast
themes; `prefers-reduced-motion`; a session from another worktree opens in its window in the
right panel.

## 14. Packaging and publishing

- `esbuild.mjs`: entry points `src/extension.ts` → `dist/extension.js` and
  `src/webview/main.ts` → `dist/webview.js` (`platform: 'browser'`, `format: 'iife'`); copy
  `src/webview/style.css` and `node_modules/@vscode/codicons/dist/codicon.{css,ttf}` to
  `dist/` / `dist/codicons/`. `.vscodeignore` already ships `dist/` and excludes `docs/`.
  `tsconfig.json` keeps `lib: ["ES2022"]`; `src/webview/main.ts` pulls in DOM types with
  `/// <reference lib="dom" />`. A lib reference is program-wide, so this does *not* stop
  extension-host code from using `window` — the rule "DOM only under `src/webview/`" is enforced
  by review, not by the compiler; a second `tsconfig` was judged not worth it (ponytail).
- `package.json`: `devDependencies` + `@vscode/codicons`; `contributes.viewsContainers`,
  `views`, `commands` (`sessionFinder.openInTab`, `sessionFinder.openInRightPanel`,
  `sessionFinder.refresh`), `menus.view/title`, `configuration` (D5 keys);
  `displayName`/`description`/`keywords` per D1. `activationEvents` stays
  `onStartupFinished` (already required by the hand-off; now also by the status bar).
- Versions: Stage 1 → **0.2.0**, Stage 2 → **0.3.0**; `CHANGELOG.md` entries in the existing
  voice (what broke, how it was found); README gains a "See what's running" section and the
  right-panel note from §11.

## 15. Out of scope (for now), and what to ask Anthropic for

- **Anything on the editor tab itself** (L1). File one feature request against the official
  extension with three items, all cheap for them: a `running` tab icon (the state already
  reaches `chooseTabIcon`); a command to approve/deny the pending permission request; a read
  API or event for per-session state. If they ship the first, Stage 1 still stands — the
  status bar and browser show *all* sessions, not just this window's tabs.
- Exact permission-prompt state via hooks (`Notification`/`Stop`) — precise, but it writes to
  the user's `settings.json`; revisit only if L5's labelling proves insufficient in use.
- Approving a permission prompt from the browser (L2 — impossible without a command).
- A rich transcript *reader* in the sidebar; "Open transcript" continues to open the raw file.
- A filter box in HISTORY (D9).
- Matching open tabs to sessions (`tabGroups` labels ↔ titles) to badge "open in this window".
- `CLAUDE_CONFIG_DIR` relocation of `~/.claude` (v0.1 limitation, unchanged).
- Codex or other providers.

## 16. Open questions

1. **`displayName` "Claude Code Sessions"** — confirm the rename (D1). The extension ID does
   not change either way.
2. **Default `activeWindow`** — `4h` (33 sessions on the author's corpus) vs `8h` (36) vs
   `2h` (17). The gate only decides what carries a state badge, so this is taste, not
   correctness.
3. **Row height** — two-line 44 px rows (this document) vs single-line 22 px with the meta
   folded into the description, which is denser but loses the project/branch line.
4. **Status bar when nothing is active** — hidden (this document) vs a muted `$(sparkle)`.
