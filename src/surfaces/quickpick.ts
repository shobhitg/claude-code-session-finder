import * as vscode from 'vscode';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { refreshIndex } from '../core/cache.js';
import { parseQuery, search, snippet, type SessionHit } from '../core/query.js';
import { planOpen } from '../core/resolve.js';
import type { SearchIndex } from '../core/types.js';
import { executePlan } from '../open.js';

interface Row extends vscode.QuickPickItem { hit?: SessionHit; action?: 'all' | 'deep' }

const ago = (ts: number) => {
  const d = Math.floor((Date.now() - ts) / 86_400_000);
  return d <= 0 ? 'today' : d === 1 ? '1d ago' : `${d}d ago`;
};

function toRow(hit: SessionHit): Row {
  const m = hit.session;
  const bits = [m.projectDir.replace(/^-/, '').split('--').pop() ?? '', m.branches.at(-1) ?? '', ago(m.lastTs)];
  if (m.prLinks.length) bits.push(`PR #${m.prLinks.at(-1)}`);
  if (!m.cwdExists) bits.push('⚠ folder missing');
  return {
    label: `$(sparkle) ${m.title ?? hit.best?.text.slice(0, 60) ?? m.sessionId}`,
    description: bits.filter(Boolean).join(' · '),
    detail: hit.best ? `${snippet(hit.best.text, hit.best.index)}   (${hit.matchCount} matches)` : undefined,
    alwaysShow: true,                    // F7 — MUST be set or VS Code re-filters on label
    buttons: [
      { iconPath: new vscode.ThemeIcon('link'), tooltip: 'Copy deep link' },
      { iconPath: new vscode.ThemeIcon('folder'), tooltip: 'Reveal folder' },
    ],
    hit,
  };
}

export async function showSearchQuickPick(ctx: vscode.ExtensionContext): Promise<void> {
  const cacheFile = join(ctx.globalStorageUri.fsPath, 'index.json');
  const defaultWindow = vscode.workspace.getConfiguration('sessionFinder').get<string>('defaultWindow', '7d');

  const qp = vscode.window.createQuickPick<Row>();
  qp.placeholder = `Search Claude sessions (last ${defaultWindow}) — "phrase", pr:123, since:all, !tools`;
  qp.matchOnDescription = false;
  qp.matchOnDetail = false;
  qp.busy = true;
  qp.show();

  let index: SearchIndex;                      // reassigned when a stale row is dropped
  try {
    ({ index } = await refreshIndex({ cacheFile }));
  } catch (err) {
    qp.hide();
    vscode.window.showErrorMessage(`Could not index Claude sessions: ${String(err)}`);
    return;
  }
  qp.busy = false;

  const render = (value: string) => {
    if (!value.trim()) { qp.items = []; return; }
    const q = parseQuery(value, defaultWindow, Date.now());
    const hits = search(index, q, Date.now());
    const rows: Row[] = hits.slice(0, 50).map(toRow);
    if (hits.length <= 2 && q.sinceMs !== null) {
      rows.push({ label: `$(history) Search all time — ${index.sessions.length} sessions`,
                  alwaysShow: true, action: 'all' });
    }
    if (hits.length === 0 && !q.deep) {
      rows.push({ label: '$(search) Search tool calls & results (slower)', alwaysShow: true, action: 'deep' });
    }
    qp.items = rows;
  };

  qp.onDidChangeValue(render);                      // 6-10 ms: synchronous, no debounce needed

  qp.onDidTriggerItemButton(async e => {
    const m = (e.item as Row).hit?.session;
    if (!m) return;
    if ((e.button.tooltip ?? '').startsWith('Copy')) {
      await vscode.env.clipboard.writeText(`vscode://anthropic.claude-code/open?session=${m.sessionId}`);
      vscode.window.setStatusBarMessage('Deep link copied', 3000);
    } else if (m.cwd) {
      await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(m.cwd));
    }
  });

  qp.onDidAccept(async () => {
    const picked = qp.selectedItems[0];
    if (!picked) return;
    if (picked.action === 'all') { qp.value = `${qp.value} since:all`; render(qp.value); return; }
    if (picked.action === 'deep') { qp.value = `!${qp.value}`; render(qp.value); return; }
    if (!picked.hit) return;

    // Spec §10: the transcript may have been deleted between indexing and now.
    // Drop it from the in-memory index so the stale row cannot be picked again.
    if (!existsSync(picked.hit.session.file)) {
      const goneId = picked.hit.session.sessionId;
      index = { ...index, sessions: index.sessions.filter(m => m.sessionId !== goneId) };
      vscode.window.showWarningMessage('That session transcript no longer exists on disk.');
      render(qp.value);
      return;
    }

    qp.hide();
    const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.path);
    await executePlan(planOpen(picked.hit.session, folders), ctx);
  });

  qp.onDidHide(() => qp.dispose());
}
