export type OpenWhere = 'tab' | 'right';
export interface CommandCall { command: string; args: unknown[] }

const EDITOR_OPEN = 'claude-vscode.editor.open';
const SIDEBAR_OPEN = 'claude-vscode.sidebar.open';

/**
 * L10 — Claude Code's routing, de-minified:
 *   route({ programmatic, preferredLocation, sessionAlreadyOpenInPanel, fullEditor }) {
 *     if (programmatic) return { target: programmatic === "honor-preferred-location" && preferredLocation === "sidebar"
 *                                         && !sessionAlreadyOpenInPanel ? "sidebar" : "panel",
 *                                 updatePreferredLocationToPanel: false };
 *     return { target: "panel", updatePreferredLocationToPanel: !fullEditor };     // ← what v0.1 triggered
 *   }
 * The sixth argument to editor.open is `options` and `options.programmatic` is what keeps Claude Code
 * from rewriting the user's preferred location. Older versions ignore the argument, so it is safe.
 * F3: `prompt` (argument 2) is always undefined — a prompt on an already-open session shows a toast.
 */
export function openCommands(sessionId: string, where: OpenWhere = 'tab'): CommandCall[] {
  const editorOpen = (programmatic: true | 'honor-preferred-location'): CommandCall =>
    ({ command: EDITOR_OPEN, args: [sessionId, undefined, undefined, undefined, undefined, { programmatic }] });
  if (where === 'right') {
    // sidebar.open sets the preferred location to "sidebar" (persistent, user-visible); the second
    // call then honours it. Two calls because there is no per-call target in Claude Code's API.
    return [{ command: SIDEBAR_OPEN, args: [] }, editorOpen('honor-preferred-location')];
  }
  return [editorOpen(true)];
}
