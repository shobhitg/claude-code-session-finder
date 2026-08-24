import * as vscode from 'vscode';
import { readFile, unlink } from 'node:fs/promises';
import { showSearchQuickPick } from './surfaces/quickpick.js';
import { claimBaton } from './baton.js';
import { batonPath } from './open.js';

async function tryClaimPendingOpen(ctx: vscode.ExtensionContext): Promise<void> {
  const path = batonPath(ctx);
  const raw = await readFile(path, 'utf8').catch(() => null);
  const outcome = claimBaton(raw, vscode.workspace.workspaceFolders?.[0]?.uri.path, Date.now());
  if ('leave' in outcome) return;
  await unlink(path).catch(() => {});                 // DELETE FIRST — makes the baton single-use
  if ('discard' in outcome) return;
  await vscode.commands.executeCommand('claude-vscode.editor.open', outcome.claim.sessionId, undefined);
}

export function activate(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('sessionFinder.search', () => showSearchQuickPick(ctx)),
  );
  void tryClaimPendingOpen(ctx);
}

export function deactivate(): void { /* nothing to tear down */ }
