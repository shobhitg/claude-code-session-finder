import * as vscode from 'vscode';
import { readFile, unlink } from 'node:fs/promises';
import { showSearchQuickPick } from './surfaces/quickpick.js';
import { claimPendingOpen } from './baton.js';
import { BATON_FILE, batonPath } from './open.js';

async function tryClaimPendingOpen(ctx: vscode.ExtensionContext): Promise<void> {
  const path = batonPath(ctx);
  await claimPendingOpen({
    read: () => readFile(path, 'utf8').catch(() => null),
    remove: () => unlink(path).catch(() => {}),
    myFolder: vscode.workspace.workspaceFolders?.[0]?.uri.path,
    // M3: the only executeCommand that was not wrapped. A missing Claude Code command
    // here must not become an unhandled rejection during activation.
    openSession: async id => {
      try {
        await vscode.commands.executeCommand('claude-vscode.editor.open', id, undefined);
      } catch {
        vscode.window.showErrorMessage('Claude Code did not accept the handed-off session.');
      }
    },
  });
}

const claim = (ctx: vscode.ExtensionContext) =>
  tryClaimPendingOpen(ctx).catch(err =>
    vscode.window.showErrorMessage(`Could not open the handed-off session: ${String(err)}`));

export function activate(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('sessionFinder.search', () => showSearchQuickPick(ctx)),
  );

  // I2: openFolder focusing an ALREADY-OPEN window is the outcome spec §9 assumes, and
  // that window's extension host is already activated — activate() never runs again. Watch
  // the baton file so a running window claims too. Both paths go through claimPendingOpen,
  // which deletes before opening, so whichever fires first wins and the other finds nothing.
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(ctx.globalStorageUri, BATON_FILE));   // F8: not Uri.file()
  watcher.onDidCreate(() => void claim(ctx));
  watcher.onDidChange(() => void claim(ctx));
  ctx.subscriptions.push(watcher);

  void claim(ctx);
}

export function deactivate(): void { /* nothing to tear down */ }
