import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(__dirname, '../src/webview/style.css'), 'utf8');

describe('webview stylesheet (spec §10, D7)', () => {
  it('contains no hex colour literal', () => {
    expect(css.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
  });
  it('every colour token is an alias of a --vscode-* variable', () => {
    const tokens = [...css.matchAll(/^\s*(--(?:s|st)-[a-z-]+):\s*([^;]+);/gm)];
    expect(tokens.length).toBeGreaterThan(12);
    for (const [, name, value] of tokens) expect(value, name).toMatch(/^var\(--vscode-/);
  });
  it('inherits font family and size from the IDE', () => {
    expect(css).toMatch(/--font:\s*var\(--vscode-font-family\)/);
    expect(css).toMatch(/--size:\s*var\(--vscode-font-size\)/);
  });
  it('respects prefers-reduced-motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
  it('styles every state the model can emit', () => {
    for (const sel of ['[data-state="running"]', '[data-reason="tool-or-permission"]', '[data-reason="your-turn"]',
                       '[data-reason="stalled"]', '[data-state="history"]']) {
      expect(css, sel).toContain(sel);
    }
  });
});
