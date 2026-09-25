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
  it('hover and focus only reveal the row actions — nothing on a row moves under the pointer (outside the narrow-sidebar fallback)', () => {
    const style = sheets[1]![1];
    const wide = style.replace(/@container[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '');   // the narrow fallback swaps on purpose
    expect(wide).toMatch(/\.row__actions \{[^}]*visibility: hidden/);
    expect(wide).toMatch(/\.row:hover \.row__actions, \.row:focus-within \.row__actions \{ visibility: visible; \}/);
    for (const rule of wide.match(/\.row:(?:hover|focus-within)[^{]*\{[^}]*\}/g) ?? []) expect(rule, rule).not.toMatch(/display:/);
    expect(style).toMatch(/@container \(max-width: 380px\)/);
  });
  it('the needs-you look (accent bar, semibold title) belongs to a row that rings, not to a state (D13)', () => {
    const style = sheets[1]![1];
    expect(style).toMatch(/\.row\[data-ringing="true"\] \.row__title \{ font-weight: 600; \}/);
    expect(style).toMatch(/\.row\[data-ringing="true"\]::before \{[^}]*background: var\(--st-needs\)/);
    expect(style).not.toMatch(/\.row\[data-reason="[a-z-]+"\]::before/);
    expect(style).not.toMatch(/\.row\[data-reason="[a-z-]+"\] \.row__title/);
  });
  it('styles every state the models can emit', () => {
    const style = sheets[1]![1], session = sheets[2]![1];
    for (const sel of ['[data-state="running"]', '[data-reason="tool-or-permission"]', '[data-reason="your-turn"]', '[data-reason="stalled"]', '[data-reason="question"]', '[data-reason="interrupted"]', '[data-state="history"]', '[aria-selected="true"]', '[data-ringing="true"]', '[data-heat="low"]', '[data-heat="mid"]', '[data-heat="warm"]', '[data-heat="high"]', '[data-heat="full"]', '.tip']) expect(style, sel).toContain(sel);
    for (const sel of ['.bar--running', '.bar--completed', '.bar--failed', '.bar--stopped', '.bar--launched', '.tool--error', '.turn--notification', '.turn--command', '.tree__tag']) expect(session, sel).toContain(sel);
  });
});
