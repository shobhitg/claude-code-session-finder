import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require(path.resolve(__dirname, '../../../package.json'));

// --disable-extensions keeps THIS extension from activating (its hard dependency is disabled —
// see quickpick.test.ts), so behaviour is unobservable here. VS Code still loads the manifest,
// and the manifest is what these tests pin down (spec §13).
suite('Live sessions manifest', () => {
  const manifest = () => vscode.extensions.getExtension(`${pkg.publisher}.${pkg.name}`)!.packageJSON;

  test('contributes the sessions view container and its webview view', () => {
    const c = manifest().contributes;
    assert.ok(c.viewsContainers?.activitybar?.some((v: { id: string }) => v.id === 'sessionFinder'), 'container sessionFinder');
    const views: Array<{ id: string; type: string }> = c.views?.sessionFinder ?? [];
    assert.ok(views.some(v => v.id === 'sessionFinder.live' && v.type === 'webview'), 'webview view sessionFinder.live');
  });

  test('contributes the session commands', () => {
    const ids = (manifest().contributes.commands as Array<{ command: string }>).map(c => c.command);
    for (const id of ['sessionFinder.search', 'sessionFinder.showSessions', 'sessionFinder.refresh',
                      'sessionFinder.openInTab', 'sessionFinder.openInRightPanel']) {
      assert.ok(ids.includes(id), `missing command ${id}`);
    }
  });

  test('contributes the live-state settings with the spec defaults', () => {
    const p = manifest().contributes.configuration.properties;
    assert.strictEqual(p['sessionFinder.activeWindow'].default, '4h');
    assert.strictEqual(p['sessionFinder.toolQuietSeconds'].default, 60);
    assert.strictEqual(p['sessionFinder.stalledMinutes'].default, 15);
  });

  test('keeps the activation and dependency contract', () => {
    const m = manifest();
    assert.deepStrictEqual(m.activationEvents, ['onStartupFinished']);
    assert.ok(m.extensionDependencies.includes('anthropic.claude-code'));
  });
});
