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
| `since:30d`, `since:all` | narrow or widen the default 60-day window |

`pr:` ignores the recency window entirely — a PR number is an exact identifier, so its age is irrelevant.
| `!"npm run build"` | also search tool calls and results, including subagents (slower) |

A `!` search matches whole transcripts, so quote a phrase (`!"npm run build"`) unless
you really do want every session that mentions all those words anywhere.

### Row actions

| Action | Behavior |
|---|---|
| Enter | opens the session — revealing an already-open tab, or opening a new one. Sessions from other git worktrees open in a window on the right folder |
| 🔗 Copy deep link | `vscode://anthropic.claude-code/open?session=<id>` to the clipboard |
| 📁 Reveal folder | reveals the session's folder in the explorer |
| 📄 Open transcript | opens the raw `.jsonl` in an editor tab — works even for a session that can no longer be resumed |

The transcript action is a row button rather than `Cmd/Ctrl+Enter`: VS Code's Quick Pick
API has no modifier-accept hook.

## See what's running

The status bar shows `⟳ 2  🔔 3`: two sessions working, three waiting on you.
Hover for the list; click to open the session search. Rows in the search show
the same glyph:

| Glyph | Meaning |
|---|---|
| `⟳` spinning | the model is working (including long answers, which write nothing for a while) |
| `🔔` | waiting on a tool call for a while — usually a **permission prompt**, sometimes just a slow tool |
| `💬` | Claude finished its turn; it's your move |
| `⚠` | nothing written for 15+ minutes mid-turn — probably abandoned |

Only sessions written in the last `sessionFinder.activeWindow` (default 4 h)
carry a state. `sessionFinder.toolQuietSeconds` (60) and
`sessionFinder.stalledMinutes` (15) tune the two thresholds. Everything is read
from `~/.claude/projects`; nothing is installed into Claude Code's settings.

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

## Read a session

**Claude: Open Session View** (or `V` on a Sessions row, or the tree icon on a
search result) opens a session in an editor tab without resuming it:

- **Agents** — the tree of everything the session spawned: agents, workflow
  runs (with their journals), agents spawned by agents, denied spawns.
- **Timeline** — one bar per agent from spawn to finish; open bars are still
  running. Click a bar to read that agent.
- **Transcript** — turns with your prompt, Claude's reply, and each tool call
  as a row you can expand for its input and output. Images from prompts show
  inline; thinking is marked, not shown (it is stored redacted).

Works for sessions whose worktree is gone. A running session's view updates as
the files are written. For a session you already have open, Claude Code's own
agents pill shows the same tree live.

## Why it activates at startup

`activationEvents` is `["onStartupFinished"]` on purpose — **do not change it to `[]`.**
When you open a session that belongs to a different folder, this extension writes a
single-use hand-off file and asks VS Code to open that folder. The window that ends up
on the target folder has to notice that file, and a lazily-activated extension in a
window nobody has invoked a command in never would. Startup activation is what makes the
hand-off arrive.

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
