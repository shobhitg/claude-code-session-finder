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
  it('hover and focus only reveal the row actions — nothing on a row moves under the pointer, at any width', () => {
    const style = sheets[1]![1];
    expect(style).toMatch(/\.row__actions \{[^}]*visibility: hidden/);
    expect(style).toMatch(/\.row:hover \.row__actions, \.row:focus-within \.row__actions \{ visibility: visible; \}/);
    for (const rule of style.match(/\.row:(?:hover|focus-within)[^{]*\{[^}]*\}/g) ?? []) expect(rule, rule).not.toMatch(/display:/);
    // a narrow sidebar lays the actions over line 2 (absolute) instead of taking the state words' place
    const narrow = /@container \(max-width: 380px\) \{([\s\S]*?)\n\}/.exec(style)?.[1] ?? '';
    expect(narrow).toMatch(/\.row__actions \{[^}]*position: absolute/);
    expect(narrow).not.toMatch(/\.row__end/);
  });
  it('the needs-you look (accent bar, semibold title) belongs to a row that rings, not to a state (D13)', () => {
    const style = sheets[1]![1];
    expect(style).toMatch(/\.row\[data-ringing="true"\] \.row__title \{ font-weight: 600; \}/);
    expect(style).toMatch(/\.row\[data-ringing="true"\]::before \{[^}]*background: var\(--st-needs\)/);
    expect(style).not.toMatch(/\.row\[data-reason="[a-z-]+"\]::before/);
    expect(style).not.toMatch(/\.row\[data-reason="[a-z-]+"\] \.row__title/);
  });
  it('the Slack mark falls back to the text colour in high-contrast themes', () => {
    expect(sheets[1]![1]).toMatch(/body\.vscode-high-contrast \.slack-mark path, body\.vscode-high-contrast-light \.slack-mark path \{ fill: currentColor; \}/);
  });
  it('ACTIVE has no fixed reserve (activeReserve sets it); collapsed, it takes none', () => {
    const style = sheets[1]![1];
    expect(style).not.toMatch(/\.section\[data-id="active"\] \.section__body \{[^}]*min-height/);
    expect(style).toMatch(/\.section\[data-collapsed="true"\] \.section__body \{ display: none; \}/);
  });
  it('high contrast outlines the cost meter\'s track, which it would paint black on black', () => {
    expect(sheets[1]![1]).toMatch(/body\.vscode-high-contrast \.heat__track, body\.vscode-high-contrast-light \.heat__track \{[^}]*outline: 1px solid var\(--s-contrast\)/);
    expect(tokens).toMatch(/--s-contrast:\s*var\(--vscode-contrastBorder/);
  });
  it('a headless run (D15) wears its own colour, purple, which nothing else uses — and a dot for every status the model emits', () => {
    const style = sheets[1]![1];
    expect(tokens).toMatch(/--st-headless:\s*var\(--vscode-charts-purple\)/);
    // purple means "a machine started this" and nothing else — not a state, and not a merged PR (GitHub's purple, until 0.10.1)
    expect(tokens.match(/--(?:s|st)-(?!headless)[a-z-]+:\s*var\(--vscode-charts-purple\)/)).toBeNull();
    for (const [name, css] of sheets) expect(css.replace(/--st-headless:[^;]*;/, ''), name).not.toMatch(/charts-purple/);
    for (const g of ['running', 'done', 'failed', 'waiting', 'stalled', 'closed']) expect(style, g).toContain(`.ghost__dot[data-ghost="${g}"]`);
    expect(style).toMatch(/\.ghost__dot\[data-ghost="running"\] \{[^}]*animation: ghost-pulse/);
  });
  it('under reduced motion the running dot and the spark hold still', () => {
    const style = sheets[1]![1];
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([^{}]*\{[^}]*\})*\s*\}/.exec(style)?.[0] ?? '';
    expect(reduced).toContain('.ghost__dot');
    expect(reduced).toContain('.ghost__spark');
  });
  it('styles every state the models can emit', () => {
    const style = sheets[1]![1], session = sheets[2]![1];
    for (const sel of ['[data-state="running"]', '[data-reason="tool-or-permission"]', '[data-reason="your-turn"]', '[data-reason="stalled"]', '[data-reason="question"]', '[data-reason="interrupted"]', '[data-state="history"]', '[aria-current="true"]', '[data-ringing="true"]', '[data-heat="low"]', '[data-heat="mid"]', '[data-heat="warm"]', '[data-heat="high"]', '[data-heat="full"]', '.tip', '[data-state="open"]', '[data-state="merged"]', '[data-state="closed"]', '[data-state="draft"]', '.where__branch--quiet', '.where__worktree--gone', '.where__item--icon', '.links__sep[hidden]', '.link--more', '.links-list']) expect(style, sel).toContain(sel);
    for (const sel of ['.bar--running', '.bar--completed', '.bar--failed', '.bar--stopped', '.bar--launched', '.tool--error', '.turn--notification', '.turn--command', '.tree__tag']) expect(session, sel).toContain(sel);
  });
});
