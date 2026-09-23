import * as vscode from 'vscode';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpenPlan } from './core/resolve.js';
import { openCommands, type OpenWhere } from './core/open-args.js';

export const BATON_TTL_MS = 60_000;
export const BATON_FILE = 'pending-open.json';
export const batonPath = (ctx: vscode.ExtensionContext) => join(ctx.globalStorageUri.fsPath, BATON_FILE);

const TRANSCRIPT_ACTION = 'Open transcript';

/** Spec §9/§10: a session you cannot resume must still be inspectable. */
export async function openTranscript(file: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(doc, { preview: true });
}

/**
 * Set by activate(): the sidebar learns which tab a session opens as, so its highlight follows exactly.
 * `onOpening` runs BEFORE Claude Code is asked — the sidebar notes which tabs exist, so the one that
 * appears afterwards is the session's; by the time the command resolves the new tab can already be there.
 */
export const openHooks: {
  onOpening: (sessionId: string, where: OpenWhere) => void;
  onOpened: (sessionId: string, where: OpenWhere) => void;
} = { onOpening: () => {}, onOpened: () => {} };

/** The only place that calls into Claude Code to open a session. L10: never call editor.open directly. */
export async function runOpen(sessionId: string, where: OpenWhere): Promise<void> {
  openHooks.onOpening(sessionId, where);
  for (const c of openCommands(sessionId, where)) await vscode.commands.executeCommand(c.command, ...c.args);
  openHooks.onOpened(sessionId, where);
}

/**
 * F8: never Uri.file() — derive from a URI that already carries the right remote authority.
 * I3: with no folder open there is no workspaceFolders[0], and throwing here made EVERY
 * open fail in a folderless window (measured 100/100 sessions plan as `handoff` there).
 * globalStorageUri is always present and carries the same authority; ctx.extensionUri
 * would do equally well.
 */
export function folderUri(path: string, ctx: vscode.ExtensionContext): vscode.Uri {
  const base = vscode.workspace.workspaceFolders?.[0]?.uri ?? ctx.globalStorageUri;
  return base.with({ path });
}

const RIGHT_PANEL_NOTICE = 'sessionFinder.rightPanelNoticeShown';

/** Spec §11: opening in the right panel also changes Claude Code's default location. Say so once. */
async function noticeRightPanelOnce(ctx: vscode.ExtensionContext): Promise<void> {
  if (ctx.globalState.get<boolean>(RIGHT_PANEL_NOTICE)) return;
  await ctx.globalState.update(RIGHT_PANEL_NOTICE, true);
  void vscode.window.showInformationMessage(
    'Opening in the right panel also makes it Claude Code\'s default location for new sessions. ' +
    'Run "Claude Code: Open in New Tab" once to switch back.');
}

export async function executePlan(plan: OpenPlan, ctx: vscode.ExtensionContext, where: OpenWhere = 'tab'): Promise<void> {
  if (plan.kind === 'transcript') {
    await openTranscript(plan.file);
    vscode.window.showInformationMessage(`Cannot resume this session: ${plan.reason}. Showing the transcript.`);
    return;
  }

  if (plan.kind === 'here') {
    if (plan.note) vscode.window.setStatusBarMessage(`Claude session: ${plan.note}`, 4000);
    // F3: reveal-if-open / new-tab-otherwise is Claude Code's own behaviour.
    // L10: openCommands() passes the programmatic flag; without it every open here silently
    // reset the user's Claude Code preferred location to "panel".
    try {
      if (where === 'right') await noticeRightPanelOnce(ctx);
      await runOpen(plan.sessionId, where);
    } catch {
      // Spec §10: offer the transcript rather than surfacing a bare error.
      const choice = await vscode.window.showErrorMessage(
        'Claude Code did not accept the session. Is the extension enabled?', TRANSCRIPT_ACTION);
      if (choice === TRANSCRIPT_ACTION) await openTranscript(plan.file);
    }
    return;
  }

  // handoff
  try {
    // I3: derive the target BEFORE writing the baton — a failure here used to leave a
    // stale baton on disk for its full 60 s TTL.
    const target = folderUri(plan.targetCwd, ctx);
    await vscode.workspace.fs.createDirectory(ctx.globalStorageUri);
    await writeFile(batonPath(ctx), JSON.stringify({
      sessionId: plan.sessionId, targetCwd: plan.targetCwd, expiresAt: Date.now() + BATON_TTL_MS, where,
    }));
    await vscode.commands.executeCommand('vscode.openFolder', target, { forceNewWindow: true });
  } catch (err) {
    vscode.window.showErrorMessage(`Could not open the session's folder: ${String(err)}`);
  }
}
