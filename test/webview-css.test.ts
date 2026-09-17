import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(__dirname, '../src/webview');
const sheets: Array<[string, string]> = ['tokens.css', 'style.css', 'session.css'].map(f => [f, readFileSync(join(dir, f), 'utf8')]);
const tokens = sheets[0]![1];

describe('webview stylesheets (spec §10, D7)', () => {
  it('contain no hex colour literal', () => {
    for (const [name, css] of sheets) expect(css.match(/#[0-9a-fA-F]{3,8}\b/g), name).toBeNull();
  });
  it('every colour token is an alias of a --vscode-* variable, and only tokens.css declares tokens', () => {
    const decls = [...tokens.matchAll(/^\s*(--(?:s|st)-[a-z-]+):\s*([^;]+);/gm)];
    expect(decls.length).toBeGreaterThan(12);
    for (const [, name, value] of decls) expect(value, name).toMatch(/^var\(--vscode-/);
    for (const [name, css] of sheets.slice(1)) expect(css, name).not.toMatch(/^\s*--(?:s|st)-[a-z-]+:/m);
  });
  it('inherits font family and size from the IDE', () => {
    expect(tokens).toMatch(/--font:\s*var\(--vscode-font-family\)/);
    expect(tokens).toMatch(/--size:\s*var\(--vscode-font-size\)/);
  });
  it('respects prefers-reduced-motion', () => {
    expect(tokens).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
  it('styles every state the models can emit', () => {
    const style = sheets[1]![1], session = sheets[2]![1];
    for (const sel of ['[data-state="running"]', '[data-reason="tool-or-permission"]', '[data-reason="your-turn"]', '[data-reason="stalled"]', '[data-state="history"]']) expect(style, sel).toContain(sel);
    for (const sel of ['.bar--running', '.bar--completed', '.bar--failed', '.bar--stopped', '.bar--launched', '.tool--error', '.turn--notification']) expect(session, sel).toContain(sel);
  });
});
