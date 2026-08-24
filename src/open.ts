import * as vscode from 'vscode';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpenPlan } from './core/resolve.js';

export const BATON_TTL_MS = 60_000;
export const batonPath = (ctx: vscode.ExtensionContext) => join(ctx.globalStorageUri.fsPath, 'pending-open.json');

/** F8: never Uri.file() — derive from an existing folder URI to keep the remote authority. */
export function folderUri(path: string): vscode.Uri {
  const base = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!base) throw new Error('No workspace folder is open — cannot derive a remote-safe folder URI.');
  return base.with({ path });
}

export async function executePlan(plan: OpenPlan, ctx: vscode.ExtensionContext): Promise<void> {
  if (plan.kind === 'transcript') {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(plan.file));
    await vscode.window.showTextDocument(doc, { preview: true });
    vscode.window.showInformationMessage(`Cannot resume this session: ${plan.reason}. Showing the transcript.`);
    return;
  }

  if (plan.kind === 'here') {
    if (plan.note) vscode.window.setStatusBarMessage(`Claude session: ${plan.note}`, 4000);
    // F3: reveal-if-open / new-tab-otherwise is Claude Code's own behaviour.
    // Pass prompt undefined, or an already-open session shows a confusing toast.
    try {
      await vscode.commands.executeCommand('claude-vscode.editor.open', plan.sessionId, undefined);
    } catch {
      vscode.window.showErrorMessage('Claude Code did not accept the session. Is the extension enabled?');
    }
    return;
  }

  // handoff
  try {
    await vscode.workspace.fs.createDirectory(ctx.globalStorageUri);
    await writeFile(batonPath(ctx), JSON.stringify({
      sessionId: plan.sessionId, targetCwd: plan.targetCwd, expiresAt: Date.now() + BATON_TTL_MS,
    }));
    await vscode.commands.executeCommand('vscode.openFolder', folderUri(plan.targetCwd), { forceNewWindow: true });
  } catch (err) {
    vscode.window.showErrorMessage(`Could not open the session's folder: ${String(err)}`);
  }
}
