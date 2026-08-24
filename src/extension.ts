import * as vscode from 'vscode';
import { showSearchQuickPick } from './surfaces/quickpick.js';

export function activate(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('sessionFinder.search', () => showSearchQuickPick(ctx)),
  );
}

export function deactivate(): void { /* nothing to tear down */ }
