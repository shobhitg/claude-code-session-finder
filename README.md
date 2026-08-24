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
