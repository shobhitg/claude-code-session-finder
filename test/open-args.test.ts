import { describe, it, expect } from 'vitest';
import { openCommands } from '../src/core/open-args.js';

describe('openCommands (spec L10, F3)', () => {
  it('opens in a tab with the programmatic flag in the SIXTH argument and no prompt', () => {
    expect(openCommands('sid-1', 'tab')).toEqual([
      { command: 'claude-vscode.editor.open',
        args: ['sid-1', undefined, undefined, undefined, undefined, { programmatic: true }] },
    ]);
    expect(openCommands('sid-1')).toEqual(openCommands('sid-1', 'tab'));
  });
  it('opens in the right panel by setting the preferred location first, then honouring it', () => {
    expect(openCommands('sid-1', 'right')).toEqual([
      { command: 'claude-vscode.sidebar.open', args: [] },
      { command: 'claude-vscode.editor.open',
        args: ['sid-1', undefined, undefined, undefined, undefined, { programmatic: 'honor-preferred-location' }] },
    ]);
  });
  it('never passes a prompt (F3) — argument 2 is undefined in every call', () => {
    for (const where of ['tab', 'right'] as const)
      for (const c of openCommands('sid-1', where))
        if (c.command === 'claude-vscode.editor.open') expect(c.args[1]).toBeUndefined();
  });
});
