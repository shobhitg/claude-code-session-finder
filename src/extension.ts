import * as vscode from 'vscode';
import { readFile, unlink } from 'node:fs/promises';
import { showSearchQuickPick } from './surfaces/quickpick.js';
import { LiveHost } from './live-host.js';
import { createStatusBar, SHOW_SESSIONS } from './surfaces/statusbar.js';
import { claimPendingOpen } from './baton.js';
import { BATON_FILE, batonPath, runOpen } from './open.js';

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
        await runOpen(id, 'tab');
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
  // Stage 1 (spec §9.2): the status bar is the glanceable answer to "which sessions are running?".
  const log = vscode.window.createOutputChannel('Claude Code Sessions', { log: true });
  const host = new LiveHost(ctx, log);
  const status = createStatusBar(ctx);
  ctx.subscriptions.push(log, host, host.onSnapshot(s => status.update(s)));
  // Until the sidebar browser exists (Stage 2) the session list IS the Quick Pick.
  ctx.subscriptions.push(vscode.commands.registerCommand(SHOW_SESSIONS, () => showSearchQuickPick(ctx, host.liveness)));
  ctx.subscriptions.push(
    vscode.commands.registerCommand('sessionFinder.search', () => showSearchQuickPick(ctx, host.liveness)),
  );

  // I2: openFolder focusing an ALREADY-OPEN window is the outcome spec §9 assumes, and
  // that window's extension host is already activated — activate() never runs again. Watch
  // the baton file so a running window claims too. Both paths go through claimPendingOpen,
  // which deletes before opening, so whichever fires first wins and the other finds nothing.
  // VS Code creates globalStorageUri lazily. A non-recursive watcher whose base directory
  // does not exist is not reliably re-armed when it appears, which would silently degrade
  // the hand-off back to activate-only — the exact failure this watcher was added to fix.
  // activate() stays synchronous (VS Code should not wait on us), so the directory is
  // ensured on a detached promise and the watcher is registered once it exists.
  void (async () => {
    try {
      await vscode.workspace.fs.createDirectory(ctx.globalStorageUri);
    } catch { /* already exists, or unwritable — createFileSystemWatcher still worth trying */ }
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(ctx.globalStorageUri, BATON_FILE));   // F8: not Uri.file()
    watcher.onDidCreate(() => void claim(ctx));
    watcher.onDidChange(() => void claim(ctx));
    ctx.subscriptions.push(watcher);
  })();

  void claim(ctx);
}

export function deactivate(): void { /* nothing to tear down */ }
