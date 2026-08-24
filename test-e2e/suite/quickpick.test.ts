import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('Quick Pick surface', () => {
  test('the search command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('sessionFinder.search'));
  });

  test('alwaysShow items survive a non-matching filter value (F7)', async () => {
    // A label that deliberately does NOT contain the typed value. Without
    // alwaysShow, VS Code's built-in label filter removes it and the assertion fails.
    const qp = vscode.window.createQuickPick();
    qp.items = [{ label: 'Email submission on calls page', alwaysShow: true }];
    qp.value = 'zzz-not-in-the-label';
    qp.show();
    await new Promise(r => setTimeout(r, 250));
    assert.strictEqual(qp.items.length, 1, 'alwaysShow must defeat the built-in filter');
    qp.dispose();
  });
});
