import { build } from 'esbuild';
import { mkdirSync, copyFileSync } from 'node:fs';

const minify = process.argv.includes('--minify');
// M10: dist/extension.js must not reference a .map the VSIX does not ship.
// `--no-sourcemap` is what vscode:prepublish uses; local builds keep the map.
const sourcemap = !process.argv.includes('--no-sourcemap');

await build({
  entryPoints: ['src/extension.ts'], bundle: true, outfile: 'dist/extension.js',
  external: ['vscode'], format: 'cjs', platform: 'node', target: 'node20', minify, sourcemap,
});

// The sidebar browser runs inside a webview — a browser — not the extension host (spec §14).
await build({
  entryPoints: ['src/webview/main.ts'], bundle: true, outfile: 'dist/webview.js',
  format: 'iife', platform: 'browser', target: 'es2022', minify, sourcemap,
});

// Static assets the view loads by URI. Codicons are the IDE's own icon font (spec §10).
mkdirSync('dist/codicons', { recursive: true });
copyFileSync('src/webview/style.css', 'dist/style.css');
for (const f of ['codicon.css', 'codicon.ttf']) {
  copyFileSync(`node_modules/@vscode/codicons/dist/${f}`, `dist/codicons/${f}`);
}
