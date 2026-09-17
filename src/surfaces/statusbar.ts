import * as vscode from 'vscode';
import { stateIcon, type Snapshot } from '../core/rows.js';
import { mdEscape } from './statusbar-escape.js';

export const SHOW_SESSIONS = 'sessionFinder.showSessions';

/**
 * Spec §9.2: "$(loading~spin) 1  $(bell-dot) 3" — running count, attention count; a zero
 * count omits its segment; hidden when ACTIVE is empty. Click runs SHOW_SESSIONS.
 */
export function createStatusBar(ctx: vscode.ExtensionContext): { update(s: Snapshot): void } {
  const item = vscode.window.createStatusBarItem('sessionFinder.live', vscode.StatusBarAlignment.Left, 50);
  item.name = 'Claude Code Sessions';
  item.command = SHOW_SESSIONS;
  ctx.subscriptions.push(item);

  return {
    update(s: Snapshot) {
      if (s.active.length === 0) { item.hide(); return; }
      const running = s.active.filter(r => r.state === 'running').length;
      const attention = s.active.length - running;
      const parts: string[] = [];
      if (running) parts.push(`$(loading~spin) ${running}`);
      if (attention) parts.push(`$(bell-dot) ${attention}`);
      item.text = parts.join('  ');

      const md = new vscode.MarkdownString(undefined, true);       // supportThemeIcons for the $(…) glyphs
      md.isTrusted = false;
      md.appendMarkdown('**Claude Code sessions**\n\n');
      for (const r of s.active) {
        const meta = [r.project, r.branch].filter(Boolean).join(' · ');
        md.appendMarkdown(`- $(${stateIcon(r)}) ${mdEscape(r.title)}${meta ? `  —  ${mdEscape(meta)}` : ''}\n`);
      }
      md.appendMarkdown(`\n_${running} running · ${attention} need you · click to open the session list_`);
      item.tooltip = md;
      item.show();
    },
  };
}
