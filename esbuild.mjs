import { build } from 'esbuild';
await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  minify: process.argv.includes('--minify'),
  // M10: dist/extension.js must not reference a .map the VSIX does not ship.
  // `--no-sourcemap` is what vscode:prepublish uses; local builds keep the map.
  sourcemap: !process.argv.includes('--no-sourcemap'),
});
