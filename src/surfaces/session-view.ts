import * as vscode from 'vscode';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { discover, defaultRoot } from '../core/discover.js';
import { parseRecords, buildTranscript, firstPrompt, overview, type Rec } from '../core/transcript.js';
import { candidates, fileKind, type Via } from '../core/fileref.js';
import { buildGraph, type AgentFile, type JournalRec, type SessionGraph } from '../core/agents.js';
import { planOpen } from '../core/resolve.js';
import type { OpenWhere } from '../core/open-args.js';
import type { SessionMeta } from '../core/types.js';
import { LiveHost, readThresholds } from '../live-host.js';
import { executePlan, folderUri, openTranscript } from '../open.js';

export const VIEW_TYPE = 'sessionFinder.sessionView';
const PAGE = 40;
const TICK_MS = 2_000;
/** The JSON view chosen per tool, remembered across sessions and windows (D20). */
const JSON_VIEWS = 'sessionView.jsonViews';
const JSON_VIEW_NAMES = new Set(['formatted', 'pretty', 'raw']);

type Inbound =
  | { type: 'ready' } | { type: 'refresh' }
  | { type: 'select'; nodeId: string }
  | { type: 'more'; nodeId: string; from: number }
  | { type: 'open'; where: OpenWhere }
  | { type: 'raw'; nodeId: string }
  | { type: 'fileInfo'; key: string; path: string; line?: number; cwd?: string }
  | { type: 'openFile'; path: string; line?: number; cwd?: string }
  | { type: 'copy'; text: string }
  | { type: 'openUrl'; href: string }
  | { type: 'jsonView'; tool: string; view: string };

/** What a file name's hover card shows (D20). */
export interface FileInfo {
  found: boolean; path: string; name: string; why: string; via?: Via;
  abs?: string; dir?: string; isDir?: boolean; entries?: number; size?: number; mtimeMs?: number; kind?: string;
  lines?: number; preview?: { start: number; lines: string[]; hl?: number }; image?: string;
}
const IMAGE_PREVIEW_MAX = 2 * 1024 * 1024;
const TEXT_PREVIEW_MAX = 512 * 1024;

function isInbound(m: unknown): m is Inbound {
  if (typeof m !== 'object' || m === null) return false;
  const o = m as Record<string, unknown>;
  switch (o.type) {
    case 'ready': case 'refresh': return true;
    case 'select': case 'raw': return typeof o.nodeId === 'string';
    case 'more': return typeof o.nodeId === 'string' && typeof o.from === 'number';
    case 'open': return o.where === 'tab' || o.where === 'right';
    case 'fileInfo': return typeof o.key === 'string' && typeof o.path === 'string' && (o.line === undefined || typeof o.line === 'number') && (o.cwd === undefined || typeof o.cwd === 'string');
    case 'openFile': return typeof o.path === 'string' && (o.line === undefined || typeof o.line === 'number') && (o.cwd === undefined || typeof o.cwd === 'string');
    case 'copy': return typeof o.text === 'string';
    case 'openUrl': return typeof o.href === 'string';
    case 'jsonView': return typeof o.tool === 'string' && typeof o.view === 'string' && JSON_VIEW_NAMES.has(o.view);
    default: return false;
  }
}

interface Cached { mtimeMs: number; size: number; recs: Rec[] }

/**
 * One editor panel per session: agent tree · timeline · transcript, read from disk without resuming
 * the session. While the session is ACTIVE (the Stage 1 tracker knows) the panel re-reads changed
 * files every 2 s; a finished session is read once.
 */
export class SessionViewManager implements vscode.Disposable {
  private readonly panels = new Map<string, SessionPanel>();

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly host: LiveHost, private readonly log: vscode.LogOutputChannel) {}

  async open(sessionId: string): Promise<void> {
    const existing = this.panels.get(sessionId);
    if (existing) { existing.reveal(); return; }
    const meta = this.host.session(sessionId) ?? await fallbackMeta(sessionId);
    if (!meta) { vscode.window.showWarningMessage('Could not find a transcript for that session.'); return; }
    const panel = new SessionPanel(this.ctx, this.host, this.log, meta, () => this.panels.delete(sessionId));
    this.panels.set(sessionId, panel);
    await panel.load(true);
  }

  /** The session whose panel is the active editor tab, if any — the sidebar highlights it. */
  activeSessionId(): string | undefined {
    for (const [id, p] of this.panels) if (p.active) return id;
    return undefined;
  }

  /** The sessions whose panel is on screen — reading one is looking at it (D13). */
  visibleSessionIds(): string[] {
    return [...this.panels].filter(([, p]) => p.visible).map(([id]) => id);
  }

  dispose(): void { for (const p of [...this.panels.values()]) p.dispose(); }
}

/** A session the index has not seen yet (brand new, or opened by id): find its file directly. */
async function fallbackMeta(sessionId: string): Promise<SessionMeta | undefined> {
  const files = await discover(defaultRoot());
  const main = files.filter(f => f.kind === 'session' && f.sessionId === sessionId).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!main) return undefined;
  return { sessionId, file: main.path, extraFiles: [], projectDir: main.projectDir, cwd: null, cwdExists: false, title: null,
           launchCwd: null, branch: null, branchNow: null, worktree: null, prs: [], slack: [], firstTs: 0, lastTs: 0, lastActTs: 0, headless: false, msgCount: 0, mtimeMs: main.mtimeMs, size: main.size };
}

const agentIdOf = (p: string): string => basename(p, '.jsonl').replace(/^agent-/, '');
/** `…/subagents/workflows/<runId>/agent-x.jsonl` → runId */
function runIdOf(p: string): string | undefined {
  const parts = p.split(sep);
  const i = parts.lastIndexOf('workflows');
  return i >= 0 && i + 2 < parts.length ? parts[i + 1] : undefined;
}

class SessionPanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly cache = new Map<string, Cached>();
  private graph: SessionGraph | undefined;
  private selected = 'session';
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly host: LiveHost, private readonly log: vscode.LogOutputChannel,
              private readonly meta: SessionMeta, onDispose: () => void) {
    const dist = vscode.Uri.joinPath(ctx.extensionUri, 'dist');
    this.panel = vscode.window.createWebviewPanel(VIEW_TYPE, meta.title ?? meta.sessionId.slice(0, 8),
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },    // a tab in the current group; Beside split the editor on every open
      { enableScripts: true, localResourceRoots: [dist], retainContextWhenHidden: true });
    this.panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'resources', 'sessions.svg');
    this.panel.webview.html = html(this.panel.webview, dist, meta.title ?? 'Session');
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage(m => void this.onMessage(m)),
      this.panel.onDidChangeViewState(() => this.schedule()),
      this.panel.onDidDispose(() => { this.stop(); for (const d of this.disposables) d.dispose(); onDispose(); }),
    );
    this.schedule();
  }

  reveal(): void { this.panel.reveal(); }
  get active(): boolean { return this.panel.active; }
  get visible(): boolean { return this.panel.visible; }
  dispose(): void { this.panel.dispose(); }

  private schedule(): void {
    this.stop();
    if (this.panel.visible) this.timer = setInterval(() => void this.tick(), TICK_MS);
  }
  private stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  private async tick(): Promise<void> {
    if (this.busy || !this.host.liveness.has(this.meta.sessionId)) return;    // finished sessions don't change
    await this.load(false);
  }

  /** Re-read what changed (by mtime:size), rebuild the graph, push it. `force` also (re)sends the page. */
  async load(force: boolean): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      let changed = force;
      const read = async (path: string): Promise<Cached | undefined> => {
        const s = await stat(path).catch(() => null);
        if (!s) return undefined;
        const hit = this.cache.get(path);
        if (hit && hit.mtimeMs === s.mtimeMs && hit.size === s.size) return hit;
        const c: Cached = { mtimeMs: s.mtimeMs, size: s.size, recs: parseRecords(await readFile(path, 'utf8')) };
        this.cache.set(path, c); changed = true;
        return c;
      };
      const main = await read(this.meta.file);
      if (!main) { this.post({ type: 'error', message: 'This session\'s transcript is no longer on disk.' }); return; }
      // discover() attributes every subagent transcript to its session across ALL project dirs — after
      // a worktree move the agents can sit under a different copy of the session than the newest main file.
      const agents: AgentFile[] = [];
      const journalPaths = new Map<string, string>();
      // a workflow's journal.jsonl sits beside its agents' files but is bookkeeping, not an agent (it was listed as one, "journal")
      for (const f of (await discover(defaultRoot())).filter(f => f.kind === 'subagent' && f.sessionId === this.meta.sessionId && basename(f.path) !== 'journal.jsonl')) {
        const c = await read(f.path); if (!c) continue;
        const runId = runIdOf(f.path);
        agents.push({ path: f.path, agentId: agentIdOf(f.path), recs: c.recs, mtimeMs: c.mtimeMs, ...(runId ? { runId } : {}) });
        if (runId && !journalPaths.has(runId)) journalPaths.set(runId, join(dirname(f.path), 'journal.jsonl'));
      }
      const journals: Record<string, JournalRec[]> = {};
      for (const [runId, jp] of journalPaths) {
        const c = await read(jp);
        if (c) journals[runId] = c.recs as JournalRec[];
      }
      if (!changed) return;
      const now = Date.now();
      this.graph = buildGraph({ title: this.meta.title ?? firstPrompt(main.recs) ?? this.meta.sessionId.slice(0, 8), mainFile: this.meta.file,
                                mainRecs: main.recs, mainMtimeMs: main.mtimeMs, agents, journals, now, thresholds: readThresholds() });
      if (!this.graph.nodes[this.selected]) this.selected = this.graph.root;
      this.panel.title = this.graph.nodes[this.graph.root]!.label;
      this.post({ type: force ? 'init' : 'update', sessionId: this.meta.sessionId, title: this.panel.title, graph: this.graph, now,
                  live: this.host.liveness.has(this.meta.sessionId), page: this.page(this.selected), jsonViews: this.jsonViews() });
    } catch (err) {
      this.log.warn(`session view: ${String(err)}`);
    } finally {
      this.busy = false;
    }
  }

  /** The transcript of a node's file, windowed — turns [from, total) — with its overview, read from all of it (D20). */
  private page(nodeId: string, from?: number): { nodeId: string; turns: ReturnType<typeof buildTranscript>['turns']; total: number; from: number; overview: ReturnType<typeof overview> } {
    const file = this.graph?.nodes[nodeId]?.file;
    const recs = file ? this.cache.get(file)?.recs ?? [] : [];
    const t = buildTranscript(recs);
    const start = Math.max(0, Math.min(from ?? t.turns.length - PAGE, t.turns.length));
    return { nodeId, turns: t.turns.slice(start), total: t.turns.length, from: start, overview: overview(t) };
  }

  private jsonViews(): Record<string, string> { return this.ctx.globalState.get<Record<string, string>>(JSON_VIEWS) ?? {}; }

  /**
   * A file name from the transcript, found on disk (D20): the first of its candidates that exists — absolute, the
   * folder the agent was in, its parents, a gone worktree's main checkout, the session's folder — with what its
   * card shows. Reads at most 512 KB of text and 2 MB of image, and only when hovered.
   */
  private async fileInfo(path: string, line: number | undefined, cwd: string | undefined): Promise<FileInfo> {
    const name = basename(path);
    const sessionCwd = this.graph?.nodes[this.graph.root]?.cwd ?? this.meta.cwd ?? undefined;
    const tried = candidates(path, { ...(cwd ? { cwd } : {}), ...(sessionCwd ? { sessionCwd } : {}), home: homedir() });
    for (const c of tried) {
      const s = await stat(c.path).catch(() => null);
      if (!s) continue;
      const info: FileInfo = { found: true, path, name, why: c.why, via: c.via, abs: c.path, dir: dirname(c.path), size: s.size, mtimeMs: s.mtimeMs };
      if (s.isDirectory()) { info.isDir = true; info.kind = 'Folder'; info.entries = (await readdir(c.path).catch(() => [])).length; return info; }
      const kind = fileKind(c.path); info.kind = kind.label;
      if (kind.image) { if (s.size <= IMAGE_PREVIEW_MAX) info.image = `data:${kind.image};base64,${(await readFile(c.path)).toString('base64')}`; return info; }
      if (s.size <= TEXT_PREVIEW_MAX) {
        const text = await readFile(c.path, 'utf8').catch(() => '');
        if (text && !text.slice(0, 8000).includes('\u0000')) {
          const all = text.split('\n'); info.lines = all.length;
          const start = line ? Math.max(1, line - 4) : 1;
          info.preview = { start, lines: all.slice(start - 1, start + 9).map(l => l.length > 200 ? `${l.slice(0, 200)}…` : l), ...(line ? { hl: line } : {}) };
        }
      }
      return info;
    }
    const where = [...new Set(tried.map(c => dirname(c.path)))].slice(0, 3).join(', ');
    return { found: false, path, name, why: `Not on disk any more${where ? ` — looked in ${where}` : ''}.` };
  }

  private async openFile(path: string, line: number | undefined, cwd: string | undefined): Promise<void> {
    const info = await this.fileInfo(path, line, cwd);
    if (!info.found || !info.abs) { void vscode.window.showWarningMessage(`${info.name} is not on disk any more.`); return; }
    const uri = folderUri(info.abs, this.ctx);                                      // F8: never Uri.file()
    if (info.isDir) { await vscode.commands.executeCommand('revealInExplorer', uri).then(undefined, () => vscode.commands.executeCommand('revealFileInOS', uri)); return; }
    if (info.image || !info.preview) { await vscode.commands.executeCommand('vscode.open', uri, vscode.ViewColumn.Beside); return; }
    const at = line ? new vscode.Range(line - 1, 0, line - 1, 0) : undefined;
    await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preview: true, ...(at ? { selection: at } : {}) });
  }

  private post(m: unknown): void { void this.panel.webview.postMessage(m); }

  private async onMessage(raw: unknown): Promise<void> {
    if (!isInbound(raw)) return;
    try {
      switch (raw.type) {
        case 'ready': if (this.graph) this.post({ type: 'init', sessionId: this.meta.sessionId, title: this.panel.title, graph: this.graph, now: Date.now(),
                                                   live: this.host.liveness.has(this.meta.sessionId), page: this.page(this.selected), jsonViews: this.jsonViews() }); return;
        case 'refresh': this.cache.clear(); await this.load(true); return;
        case 'select': this.selected = raw.nodeId; this.post({ type: 'page', page: this.page(raw.nodeId), now: Date.now() }); return;
        case 'more': this.post({ type: 'page', page: this.page(raw.nodeId, raw.from), now: Date.now() }); return;
        case 'raw': { const file = this.graph?.nodes[raw.nodeId]?.file ?? this.meta.file; await openTranscript(file); return; }
        case 'fileInfo': this.post({ type: 'fileInfo', key: raw.key, info: await this.fileInfo(raw.path, raw.line, raw.cwd) }); return;
        case 'openFile': await this.openFile(raw.path, raw.line, raw.cwd); return;
        case 'copy': await vscode.env.clipboard.writeText(raw.text); vscode.window.setStatusBarMessage('Copied', 1500); return;
        case 'openUrl': if (/^https?:\/\//i.test(raw.href)) await vscode.env.openExternal(vscode.Uri.parse(raw.href, true)); return;
        case 'jsonView': await this.ctx.globalState.update(JSON_VIEWS, { ...this.jsonViews(), [raw.tool]: raw.view }); return;
        case 'open': {
          const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.path);
          await executePlan(planOpen(this.meta, folders), this.ctx, raw.where);
          return;
        }
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Session view: ${String(err)}`);
    }
  }
}

function html(webview: vscode.Webview, dist: vscode.Uri, title: string): string {
  const nonce = randomBytes(16).toString('hex');
  const uri = (p: string): string => webview.asWebviewUri(vscode.Uri.joinPath(dist, p)).toString();
  // img-src data: — prompt images travel inline as data URLs (transcript.ts caps them at 2 MB each)
  const csp = `default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src data:; script-src 'nonce-${nonce}';`;
  const esc = (s: string): string => s.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] ?? c));
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri('codicons/codicon.css')}">
<link rel="stylesheet" href="${uri('tokens.css')}">
<link rel="stylesheet" href="${uri('session.css')}">
<title>${esc(title)}</title>
</head><body>
<main id="app" class="app" aria-label="Session view"></main>
<script nonce="${nonce}" src="${uri('session.js')}"></script>
</body></html>`;
}
