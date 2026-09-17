# Changelog

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
