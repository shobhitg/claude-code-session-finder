# Changelog

## 0.5.0

**The Sessions view is about this workspace.** It lists sessions from the
workspace's folders, their git repository and every worktree of it — so a
session started in `.worktrees/feature` is yours, and the other project in
your other window is not. The filter button in the view title switches to all
projects for this workspace; `sessionFinder.sidebarScope` sets the default.
The status bar and the search picker still cover everything, because "what
needs me?" is a question about the whole machine. Membership is decided by the
session's last recorded cwd; a session with none falls back to Claude Code's
project-directory name.

**A filter box in the sidebar.** Type (or press `/`) to search inside sessions
with the picker's syntax — words, `"phrase"`, `pr:123`, `since:all`. Unlike the
picker, results stay on screen: open one, read another in the Session View,
refine, then `Esc` restores the list. Each result shows the line that matched
and keeps its live glyph. Deep `!` searches stay in the picker.

**Sessions no longer fall into HISTORY while you are working in them.** The
live state is read from the last few KB of a transcript. One screenshot pasted
or read as an image is a 400 KB record; when it straddled the read window the
tail looked like nothing but sidecars, the verdict was "unknown", and an
unknown verdict dropped the session from ACTIVE — the session you were typing
in, listed under HISTORY. The reader now widens until it finds a conversational
record (up to the whole file, rarely), and recency alone decides membership:
written within `sessionFinder.activeWindow` (4 h by default) means ACTIVE, and
an unknown verdict merely shows as running.

**Interrupted and asked-a-question are states of their own.** Pressing `Esc`
writes a user message (`[Request interrupted by user]`), which read as "the
model is generating", so an interrupted session spun forever. It now shows ⊘
"interrupted" at once. A pending `AskUserQuestion` used to be a slow tool
until the 60-second bell; it now shows `?` "asks you" immediately and sorts
first. A finished turn reads "done · N ago". Every glyph has a tooltip saying
what it means.

**The active session is highlighted.** Switch between Claude Code tabs, or
Session Views, and the matching row in the sidebar is selected and scrolled
into view. A session opened from here is highlighted at once, and the tab
Claude Code gives it is remembered, so switching back to that tab resolves by
id even when several sessions share a title. Tabs opened elsewhere are found
by title, most recently written first. A file or terminal tab leaves the
highlight where it was.

## 0.4.1

**A recognisable activity bar icon.** The Sessions view's icon was Claude
Code's asterisk with a dot — one slot below Claude Code's own asterisk, it
read as a duplicate. It is now the Marketplace icon's motif, a magnifier
holding the session asterisk, so the entry point to the Sessions view is
findable.

## 0.4.0

**A Session View.** From a Sessions row (`V`), the Quick Pick, or the palette
(`Claude: Open Session View`), open any session — running, finished, or from a
worktree that no longer exists — in an editor tab, read straight from the
transcript files without resuming it. Three panes: the **agent tree** (who
spawned whom, workflow runs grouped, denied spawns as dead ends), a
**timeline** of when each agent ran and how much overlapped, and the selected
node's **transcript** as turns: your prompts, Claude's text, tool calls as
compact rows with collapsed output, images inline, background-agent
notifications. Click an agent's row or bar, or "open agent →" on the spawning
tool call, to read that agent. While the session is active the view keeps up
with the files every two seconds.
Slash commands the CLI echoed into the transcript (`/model`, `/clear`) read as
commands with their output, not as something you said, and never title a
session. In a narrow pane the tree stacks above the reader.

Two facts of the transcript format shaped this: a background agent's
completion arrives as a `<task-notification>` user message whose task-id is the
agent's filename, so agents spawned *by agents* link up through it; and
thinking blocks are stored redacted, so the reader marks them rather than
pretending to show them.

Claude Code has its own in-session "Agent map" (the agents pill in a session's
header). This view is for the sessions you don't have open.

## 0.3.0

**Renamed.** It started as a search box for old sessions; with live state,
a browser and agent trees it is about all your sessions, so the name says so:
*Claude Code Sessions & Agents* on the Marketplace, *Claude Code Sessions* for
the view inside VS Code. The extension id is unchanged
(`shobhitg.claude-code-session-finder`) — existing installs update in place,
and the commands, settings (`sessionFinder.*`) and keybinding are the same.

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

## 0.2.0

**You can now see which sessions are running.** The status bar shows how many
Claude Code sessions are working and how many are waiting on you; hovering
lists them. Search results carry the same glyph. State is read from the
transcripts on disk — no hooks, no settings changes — by looking at the last
*conversational* record of each recently written session: the model's
`stop_reason` says whether it finished its turn or is waiting on a tool, and a
`user` record means it is still generating. That last rule matters: a long
answer writes nothing for minutes, and an earlier draft of this feature flagged
the very session that was writing it as "blocked". Thresholds are settings
(`sessionFinder.activeWindow`, `toolQuietSeconds`, `stalledMinutes`).

**Opening a session no longer resets your Claude Code "preferred location".**
`claude-vscode.editor.open` called without its sixth argument is treated by
Claude Code as a user-initiated open and rewrites the preferred location to
"panel". Every open from this extension had been doing that since 0.1.0. Calls
now pass `{ programmatic: true }`.

Also: `since:2h` works in searches (the window parser gained an hour unit).

## 0.1.1

Three fixes, all found by real use rather than by tests.

**The first search of a window silently returned nothing.** The picker appears
immediately and accepts input, but `onDidChangeValue` was registered *after* the
cold index build. Anything typed during that ~1.6 s landed in the input with no
listener attached, and once the listener was finally added it only fired on
future changes — so the already-typed query never rendered. The result was "no
results" from a perfectly healthy index. Keystrokes are now buffered before the
build and replayed after it.

**`pr:` was filtered by the recency window.** A PR number is a globally unique
identifier: if you type `pr:18942` there is exactly one right answer and its age
is irrelevant. Applying the default window hid 55% of the author's PR numbers.
Exact-identifier queries now ignore the window entirely.

**The default window is now 60 days, was 7.** On a real corpus the 7-day window
covered 26% of sessions while an all-time query cost 27 ms — three quarters of
the history hidden to save nothing. Configurable via `sessionFinder.defaultWindow`.

Also: the cross-window hand-off's file watcher now ensures its storage directory
exists before watching it. VS Code creates that directory lazily, and a
non-recursive watcher on a missing base is not reliably armed when it appears —
which would have silently degraded the hand-off to activate-only.

## 0.1.0

First release.
