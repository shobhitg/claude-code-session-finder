import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { LiveHost } from '../live-host.js';
import { firstPrompts, resolveTabSession, rowsForHits, type Snapshot } from '../core/rows.js';
import { parseQuery, search } from '../core/query.js';
import type { SearchIndex } from '../core/types.js';
import { VIEW_TYPE as SESSION_VIEW_TYPE } from './session-view.js';
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
  | { type: 'filter'; q: string }
  | { type: 'toggleScope' }
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
    case 'ready': case 'search': case 'toggleScope': return true;
    case 'filter': return typeof o.q === 'string';
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
  /** What the active editor tab is: a Claude Code session tab (known by its label) or one of our Session Views. */
  private activeTab: { kind: 'claude'; label: string } | { kind: 'own' | 'opened'; sessionId: string } | null = null;
  /** A session this extension just opened; the Claude Code tab that activates next is its tab. */
  private opened: { sessionId: string; at: number } | null = null;
  /** Claude Code tab label → session id, learned from our own opens. Exact where titles are ambiguous. */
  private readonly learned: Map<string, string>;
  private pendingFilter: { q: string } | null = null;
  private titlesFor: SearchIndex | null = null;
  private titles = new Map<string, string>();

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly host: LiveHost,
              private readonly ownActiveSession: () => string | undefined = () => undefined,
              private readonly log?: vscode.LogOutputChannel) {
    this.learned = new Map(Object.entries(ctx.workspaceState.get<Record<string, string>>('tabLabels') ?? {}));
    ctx.subscriptions.push(host.onSnapshot(s => this.post(s)));
  }

  /**
   * Called from runOpen(): highlight the session at once (the user just chose it), and remember the
   * Claude Code tab that appears for it, so later switches to that tab resolve by id rather than by
   * title — three sessions can share one AI title. A right-panel open is not a tab; nothing to learn.
   */
  noteOpened(sessionId: string, where: OpenWhere): void {
    this.activeTab = { kind: 'opened', sessionId };
    this.postActive();
    if (where !== 'tab') return;
    this.opened = { sessionId, at: Date.now() };
    // Re-activating an already-active tab fires no tab event; one late look covers that path.
    setTimeout(() => { if (this.opened?.sessionId === sessionId) this.noteActiveTab(); }, 1_500);
  }

  private learn(label: string, sessionId: string): void {
    if (this.learned.get(label) === sessionId) return;
    this.learned.set(label, sessionId);
    void this.ctx.workspaceState.update('tabLabels', Object.fromEntries(this.learned));
    this.log?.info(`learned tab label "${label}" → ${sessionId}`);
  }

  /**
   * Called on every tab change. A Claude Code tab is recognised by its webview type and named by
   * its label; one of our Session Views by its panel. Any other tab (a file, a terminal) leaves the
   * highlight where it was — you are still working in that session.
   */
  noteActiveTab(): void {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const input = tab?.input;
    if (!tab || !(input instanceof vscode.TabInputWebview)) {
      this.log?.debug(`active tab: not a webview (${input?.constructor.name ?? 'none'}) — highlight kept`);
      return;
    }
    if (input.viewType.includes('claudeVSCodePanel')) {
      if (this.opened && Date.now() - this.opened.at < 5_000) { this.learn(tab.label, this.opened.sessionId); this.opened = null; }
      this.activeTab = { kind: 'claude', label: tab.label };
    }
    else if (input.viewType.includes(SESSION_VIEW_TYPE)) { const id = this.ownActiveSession(); if (id) this.activeTab = { kind: 'own', sessionId: id }; }
    else { this.log?.debug(`active tab: webview ${input.viewType} — not a session`); return; }
    this.log?.info(`active tab: ${input.viewType} "${tab.label}" → session ${this.activeId() ?? 'not found in the list'}`);
    this.postActive();
  }

  private postActive(): void {
    if (this.view) void this.view.webview.postMessage({ type: 'active', sessionId: this.activeId() });
  }

  private activeId(): string | null {
    const a = this.activeTab;
    if (!a) return null;
    if (a.kind !== 'claude') return a.sessionId;
    return this.learned.get(a.label) ?? resolveTabSession(a.label, this.host.snapshot) ?? null;
  }

  /** The title-bar search button and `Claude: Filter Sessions`: focus the inline filter, optionally with a query. */
  focusFilter(q?: string): void {
    const msg = { type: 'focusFilter', ...(q !== undefined ? { q } : {}) };
    if (this.view) void this.view.webview.postMessage(msg); else this.pendingFilter = { q: q ?? '' };
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
    void this.view.webview.postMessage({ type: 'snapshot', snapshot, now: Date.now(), activeWindow, active: this.activeId() });
  }

  /** The inline filter: the Quick Pick's prose search, as rows that stay on screen. Deep (!) stays in the picker. */
  private postResults(q: string): void {
    if (!this.view) return;
    const index = this.host.searchIndex;
    const defaultWindow = vscode.workspace.getConfiguration('sessionFinder').get<string>('defaultWindow', '60d');
    const parsed = parseQuery(q, defaultWindow, Date.now());
    if (index && this.titlesFor !== index) { this.titles = firstPrompts(index); this.titlesFor = index; }
    const rows = index && !parsed.deep && q.trim()
      ? rowsForHits(search(index, parsed, Date.now()).filter(h => this.host.inScope(h.session)), this.host.liveness, this.titles) : [];
    void this.view.webview.postMessage({ type: 'results', q, deep: parsed.deep, rows, now: Date.now(), indexing: !index });
  }

  private async onMessage(raw: unknown): Promise<void> {
    if (!isInbound(raw)) return;
    try {
      if (raw.type === 'ready') {
        this.post(this.host.snapshot);
        if (this.pendingFilter) { this.focusFilter(this.pendingFilter.q); this.pendingFilter = null; }
        return;
      }
      if (raw.type === 'filter') { this.postResults(raw.q); return; }
      if (raw.type === 'toggleScope') { await this.host.toggleScope(); return; }
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
