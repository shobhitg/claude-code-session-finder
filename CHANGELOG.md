# Changelog

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
