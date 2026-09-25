import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(__dirname, '../src/webview');
const sources: Array<[string, string]> = ['main.ts', 'session/main.ts'].map(f => [f, readFileSync(join(dir, f), 'utf8')]);

describe('webview keyboard handling', () => {
  // VS Code's webview host listens for keydown on the webview's window and relays it to the workbench,
  // which performs paste, select all, undo… On desktop it blocks the browser's own clipboard keys, so a
  // keydown that never reaches the window is a Cmd+V that does nothing.
  it('no keydown handler stops propagation: Cmd+V / Cmd+A / Cmd+Z must reach VS Code', () => {
    for (const [name, src] of sources) {
      const handlers = [...src.matchAll(/addEventListener\('keydown'[\s\S]*?\n\}\);/g)].map(m => m[0]);
      for (const h of handlers) expect(h, name).not.toMatch(/stopPropagation/);
    }
  });
  it('the list shortcuts ignore keys typed into the filter and Cmd/Ctrl/Alt chords', () => {
    const list = /root\.addEventListener\('keydown'[\s\S]*?\n\}\);/.exec(sources[0]![1])![0];
    expect(list).toMatch(/e\.target === filterInput/);
    expect(list).toMatch(/e\.metaKey \|\| e\.ctrlKey \|\| e\.altKey/);
  });
});
