import Mocha from 'mocha';
import { glob } from 'glob';
import * as path from 'node:path';

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true });
  const root = __dirname;
  for (const f of await glob('**/*.test.js', { cwd: root })) mocha.addFile(path.resolve(root, f));
  await new Promise<void>((resolve, reject) =>
    mocha.run(failures => (failures ? reject(new Error(`${failures} tests failed`)) : resolve())));
}
