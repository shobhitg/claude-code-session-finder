import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { LiveHost } from '../live-host.js';
import type { Snapshot } from '../core/rows.js';
import { planOpen } from '../core/resolve.js';
import type { OpenWhere } from '../core/open-args.js';
import { executePlan, folderUri, openTranscript } from '../open.js';

export const VIEW_ID = 'sessionFinder.live';

// One member per `type`, not `'transcript' | 'copyLink' | 'reveal'` in one member: the early
// returns in onMessage narrow by discriminant, and a shared member would leave `raw` un-narrowed
// at the `open` step (TS2339 on `raw.where`).
type Inbound =
  | { type: 'ready' }
  | { type: 'search' }
  | { type: 'open'; sessionId: string; where: OpenWhere }
  | { type: 'view'; sessionId: string }
  | { type: 'transcript'; sessionId: string }
  | { type: 'copyLink'; sessionId: string }
  | { type: 'reveal'; sessionId: string };

/** Spec §12: every field read from a webview message is checked first; unknown shapes are ignored. */
function isInbound(m: unknown): m is Inbound {
  if (typeof m !== 'object' || m === null) return false;
  const o = m as Record<string, unknown>;
  switch (o.type) {
    case 'ready': case 'search': return true;
    case 'open': return typeof o.sessionId === 'string' && (o.where === 'tab' || o.where === 'right');
    case 'view': case 'transcript': case 'copyLink': case 'reveal': return typeof o.sessionId === 'string';
    default: return false;
  }
}

/**
 * Spec §9.1. The host owns the state (D4); this class only ships Snapshots to the webview and
 * turns its messages into the same actions the Quick Pick offers. retainContextWhenHidden is
 * deliberately not set: the webview re-renders from the next snapshot after `ready`.
 */
export class LiveViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private indexTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly host: LiveHost) {
    ctx.subscriptions.push(host.onSnapshot(s => this.post(s)));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const dist = vscode.Uri.joinPath(this.ctx.extensionUri, 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    view.webview.html = this.html(view.webview, dist);
    view.webview.onDidReceiveMessage(m => void this.onMessage(m));
    // D6: whole-file index work only while someone is looking.
    view.onDidChangeVisibility(() => this.onVisibility(view.visible));
    view.onDidDispose(() => { this.onVisibility(false); this.view = undefined; });
    this.onVisibility(view.visible);
  }

  private onVisibility(visible: boolean): void {
    if (this.indexTimer) clearInterval(this.indexTimer);
    this.indexTimer = undefined;
    if (!visible) return;
    void this.host.refreshIndex();
    this.indexTimer = setInterval(() => void this.host.refreshIndex(), 60_000);
  }

  private post(snapshot: Snapshot): void {
    if (!this.view) return;
    const activeWindow = vscode.workspace.getConfiguration('sessionFinder').get<string>('activeWindow', '4h');
    void this.view.webview.postMessage({ type: 'snapshot', snapshot, now: Date.now(), activeWindow });
  }

  private async onMessage(raw: unknown): Promise<void> {
    if (!isInbound(raw)) return;
    try {
      if (raw.type === 'ready') { this.post(this.host.snapshot); return; }
      if (raw.type === 'search') { await vscode.commands.executeCommand('sessionFinder.search'); return; }
      if (raw.type === 'copyLink') {
        await vscode.env.clipboard.writeText(`vscode://anthropic.claude-code/open?session=${raw.sessionId}`);
        vscode.window.setStatusBarMessage('Deep link copied', 3000);
        return;
      }
      if (raw.type === 'view') { await vscode.commands.executeCommand('sessionFinder.openSessionView', raw.sessionId); return; }
      const m = this.host.session(raw.sessionId);
      if (!m) { vscode.window.showWarningMessage('That session is not in the index yet — try again in a moment.'); return; }
      if (raw.type === 'transcript') { await openTranscript(m.file); return; }
      if (raw.type === 'reveal') {
        if (m.cwd) await vscode.commands.executeCommand('revealInExplorer', folderUri(m.cwd, this.ctx));   // F8
        return;
      }
      // open — v0.1 §10: the transcript may have gone between indexing and the click.
      if (!existsSync(m.file)) {
        vscode.window.showWarningMessage('That session transcript no longer exists on disk.');
        void this.host.refreshIndex();
        return;
      }
      const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.path);
      await executePlan(planOpen(m, folders), this.ctx, raw.where);
    } catch (err) {
      vscode.window.showErrorMessage(`Action failed: ${String(err)}`);
    }
  }

  private html(webview: vscode.Webview, dist: vscode.Uri): string {
    const nonce = randomBytes(16).toString('hex');
    const uri = (p: string) => webview.asWebviewUri(vscode.Uri.joinPath(dist, p)).toString();
    const csp = `default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri('codicons/codicon.css')}">
<link rel="stylesheet" href="${uri('tokens.css')}">
<link rel="stylesheet" href="${uri('style.css')}">
<title>Claude Code Sessions</title>
</head><body>
<main id="app" tabindex="0" aria-label="Claude Code sessions"></main>
<script nonce="${nonce}" src="${uri('webview.js')}"></script>
</body></html>`;
  }
}
