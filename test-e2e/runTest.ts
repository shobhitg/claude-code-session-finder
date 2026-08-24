import { runTests } from '@vscode/test-electron';
import * as path from 'node:path';

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');
  await runTests({ extensionDevelopmentPath, extensionTestsPath, launchArgs: ['--disable-extensions'] });
}

main().catch(err => {
  console.error('e2e failed', err);
  process.exit(1);
});
