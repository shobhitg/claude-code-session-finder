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
    // shown on hover and on KEYBOARD focus — not on the focus a click leaves on the row
    expect(style).toMatch(/\.row:hover \.row__actions, \.row:focus-visible \.row__actions, \.row:has\(:focus-visible\) \.row__actions \{ visibility: visible; \}/);
    expect(style).not.toMatch(/\.row:focus-within \.row__actions/);
    for (const rule of style.match(/\.row:(?:hover|focus-within|focus-visible)[^{]*\{[^}]*\}/g) ?? []) expect(rule, rule).not.toMatch(/display:/);
    // laid over line 2 at every width, so line 1 keeps no empty slot beside the title (D18)
    expect(style).toMatch(/\.row__actions \{[^}]*position: absolute/);
    expect(style).not.toMatch(/@container/);
  });
  it('a row\'s tooltips are never painted over by the next row: the hovered row is lifted, and nothing that hosts a tooltip is dimmed with opacity (D18)', () => {
    const style = sheets[1]![1];
    expect(style).toMatch(/\.row:hover, \.row:focus-within \{ z-index: 1; \}/);
    const hosts = /(?:\.row(?:\[[^\]]*\])*|\.row__icon|\.row__lines|\.row__time|\.where|\.where__branch|\.link|\.row__heat)\s*$/;
    for (const [, sel, body] of style.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      for (const one of sel!.split(',')) if (hosts.test(one.trim())) expect(body, one.trim()).not.toMatch(/(?:^|;|\s)opacity:/);
    }
    // and the tooltip is frosted glass (D19): mostly the hover colour, over a blur — solid in high contrast
    expect(style).toMatch(/\.tip::after \{[^}]*background: color-mix\(in srgb, var\(--s-tip-bg\) 82%, transparent\);/);
    // the blur only on the tooltip showing — on every hidden one it was a compositing layer each
    expect(style).not.toMatch(/\.tip::after \{[^}]*backdrop-filter/);
    expect(style).toMatch(/\.tip:hover::after, \.tip:focus-visible::after \{ -webkit-backdrop-filter: blur\(12px\) saturate\(1\.4\); backdrop-filter: blur\(12px\) saturate\(1\.4\); \}/);
    expect(style).toMatch(/body\.vscode-high-contrast \.tip::after[^{]*\{ background: var\(--s-tip-bg\); backdrop-filter: none;/);
  });
  it('the needs-you look (accent bar, semibold title) belongs to a row that rings, not to a state (D13)', () => {
    const style = sheets[1]![1];
    expect(style).toMatch(/\.row\[data-ringing="true"\] \.row__title \{ font-weight: 600; \}/);
    expect(style).toMatch(/\.row\[data-ringing="true"\]::before \{[^}]*background: var\(--st-needs\)/);
    expect(style).not.toMatch(/\.row\[data-reason="[a-z-]+"\]::before/);
    expect(style).not.toMatch(/\.row\[data-reason="[a-z-]+"\] \.row__title/);
  });
  it('the state words wear their state\'s colour, mixed toward the text colour so they read on light themes too (D18)', () => {
    const style = sheets[1]![1];
    const tx = [...tokens.matchAll(/^\s*(--tx-[a-z]+):\s*([^;]+);/gm)];
    expect(tx.map(([, n]) => n)).toEqual(['--tx-running', '--tx-needs', '--tx-ok', '--tx-stalled', '--tx-error', '--tx-sheen']);
    for (const [, name, value] of tx.slice(0, 5)) expect(value, name).toMatch(/^color-mix\(in oklab, var\(--st-[a-z]+\) \d+%, var\(--s-fg\)\)$/);
    expect(tx[5]![2]).toMatch(/^color-mix\(in oklab, var\(--tx-running\) \d+%, var\(--s-fg\)\)$/);   // the shimmer's band: still the running hue
    for (const tone of ['running', 'needs', 'done', 'stalled', 'failed']) expect(style, tone).toMatch(new RegExp(`\\.row\\[data-tone="${tone}"\\] \\.row__time \\{ color: var\\(--tx-`));
  });
  it('the Slack mark falls back to the text colour in high-contrast themes', () => {
    expect(sheets[1]![1]).toMatch(/body\.vscode-high-contrast \.slack-mark path, body\.vscode-high-contrast-light \.slack-mark path \{ fill: currentColor; \}/);
  });
  it('ACTIVE has no fixed reserve (activeReserve sets it); collapsed, it takes none', () => {
    const style = sheets[1]![1];
    expect(style).not.toMatch(/\.section\[data-id="active"\] \.section__body \{[^}]*min-height/);
    expect(style).toMatch(/\.section\[data-collapsed="true"\] \.section__body \{ display: none; \}/);
  });
  it('the cost meter fills along one ramp — its own cyan, then amber, then red — that it reveals as it grows; past the budget, solid red (D17–D19)', () => {
    const style = sheets[1]![1];
    expect(style).toMatch(/\.heat__fill \{[^}]*transform: scaleX\(var\(--p, 0\)\);[^}]*background: linear-gradient\(90deg, var\(--st-cost\) 0 60%, var\(--st-warm\) 82%, var\(--st-full\) 100%\) 0 0 \/ calc\(100% \/ max\(var\(--p, 1\), \.02\)\) 100% no-repeat;/);
    expect(style).not.toMatch(/\.heat__fill \{[^}]*transition: width/);   // transform only: the meter never re-lays out its row
    expect(tokens).toMatch(/--st-cost:\s*var\(--vscode-terminal-ansiCyan/);
    expect(style).toMatch(/\.row\[data-heat="full"\] \.heat__fill \{ background: var\(--st-full\); \}/);
  });
  it('the live layer (D19): running words shimmer, a running row streams along its foot, the running glyph is a sparkle, live glyphs glow, a finish bursts — and all of it holds still under reduced motion', () => {
    const style = sheets[1]![1];
    expect(style).toMatch(/\.row\[data-tone="running"\]:not\(\[aria-current="true"\]\) \.row__time \{[^}]*background-clip: text;[^}]*animation: shimmer/);
    expect(style).toMatch(/\.row\[data-tone="running"\]::after \{[^}]*animation: sweep/);
    expect(style).toMatch(/\.spark__svg \{[^}]*animation: spark-breathe/);
    expect(style).toMatch(/\.row\[data-ringing="true"\]::before \{[^}]*animation: bell-glow/);
    expect(style).toMatch(/\.burst i \{[^}]*animation: burst 900ms ease-out forwards/);
    expect(style).toMatch(/text-shadow: 0 0 6px color-mix\(in srgb, currentColor 70%, transparent\)/);
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(style)?.[1] ?? '';
    for (const sel of ['.spark__svg', '.row[data-tone="running"] .row__time', '.row[data-ringing="true"]::before', '.heat__label']) expect(reduced, sel).toContain(sel);
    expect(reduced).toMatch(/\.row\[data-tone="running"\]::after, \.burst \{ display: none; \}/);
  });
  it('the filter\'s edge wears the running → cost → done gradient, but high contrast keeps its border (D19)', () => {
    const style = sheets[1]![1];
    expect(style).toMatch(/body:not\(\.vscode-high-contrast\):not\(\.vscode-high-contrast-light\) \.filter__input \{[^}]*linear-gradient\(90deg, var\(--st-running\), var\(--st-cost\), var\(--st-ok\)\) border-box/);
  });
  it('high contrast outlines the cost meter\'s track, which it would paint black on black', () => {
    expect(sheets[1]![1]).toMatch(/body\.vscode-high-contrast \.heat__track, body\.vscode-high-contrast-light \.heat__track \{[^}]*outline: 1px solid var\(--s-contrast\)/);
    expect(tokens).toMatch(/--s-contrast:\s*var\(--vscode-contrastBorder/);
  });
  it('a headless run (D15) wears its own colour, purple, which nothing else uses — and a dot for every status the model emits', () => {
    const style = sheets[1]![1];
    expect(tokens).toMatch(/--st-headless:\s*var\(--vscode-charts-purple\)/);
    // purple means "a machine started this" and nothing else — not a state, and not a merged PR (GitHub's purple, in the 0.10.0 previews)
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
    for (const sel of ['[data-state="running"]', '[data-reason="tool-or-permission"]', '[data-reason="your-turn"]', '[data-reason="stalled"]', '[data-reason="question"]', '[data-reason="interrupted"]', '[data-state="history"]', '[aria-current="true"]', '[data-ringing="true"]', '[data-heat="high"]', '[data-heat="full"]', '.spark__svg', '.burst', '[data-tone="running"]', '.tip', '[data-state="open"]', '[data-state="merged"]', '[data-state="closed"]', '[data-state="draft"]', '.where__branch--quiet', '.where__worktree--gone', '.where__item--icon', '.links__sep[hidden]', '.link--more', '.links-list']) expect(style, sel).toContain(sel);
    for (const sel of ['.st-running', '.st-launched', '.st-completed', '.st-failed', '.st-stopped', '.tool--error', '.tool--pending', '.turn--notification', '.turn--command', '.fp--gone', '.fp--missing', '.finding--major', '.finding--minor', '.grp--closed', '.cp--done', '.json__note', '.nokept', '.think']) expect(session, sel).toContain(sel);
  });
});
