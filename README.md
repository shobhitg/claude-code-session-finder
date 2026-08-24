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
| `pr:18942` | the session that opened that PR |
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
