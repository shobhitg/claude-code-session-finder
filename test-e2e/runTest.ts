import { runTests } from '@vscode/test-electron';
import * as path from 'node:path';
import * as os from 'node:os';

// If you are running this from inside a Claude Code session, unset
// ELECTRON_RUN_AS_NODE first: Claude Code's own environment sets it, which makes
// the downloaded VS Code binary run as plain Node instead of as VS Code. It then
// rejects every VS Code flag (e.g. "bad option: --disable-extensions") and exits
// with code 9 — a message that points nowhere near the real cause. Invoke as:
//   env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm run test:e2e
async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');
  // The user-data dir holds VS Code's IPC socket, and Unix socket paths are capped at 107 chars.
  // From a worktree under .worktrees/ the default (.vscode-test/user-data/...) is longer and VS Code
  // dies with `listen EINVAL`, so pin a short one. (See the ELECTRON_RUN_AS_NODE note above too.)
  const userDataDir = path.join(os.tmpdir(), 'ccsf-e2e-user-data');
  await runTests({ extensionDevelopmentPath, extensionTestsPath,
                   launchArgs: ['--disable-extensions', `--user-data-dir=${userDataDir}`] });
}

main().catch(err => {
  console.error('e2e failed', err);
  process.exit(1);
});
