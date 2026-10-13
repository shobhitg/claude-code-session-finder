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
  it('a draft PR is a dashed muted-green pill, and a folder that is gone says so in the warning colour (D21)', () => {
    const style = sheets[1]![1];
    expect(tokens).toMatch(/--pr-draft:\s*color-mix\(in oklab, var\(--vscode-charts-green\) \d+%, var\(--vscode-descriptionForeground\)\);/);
    expect(style).toMatch(/\.link--pr\[data-state="draft"\] \{ box-shadow: none; outline: 1px dashed/);
    expect(style).toMatch(/\.row__missing \{[^}]*color: var\(--tx-stalled\)/);
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
    // full purple means "a machine started this" and nothing else; a merged PR is a soft violet — purple mixed with blue (D21)
    expect(tokens.match(/--(?:s|st)-(?!headless)[a-z-]+:\s*var\(--vscode-charts-purple\)/)).toBeNull();
    expect(tokens).toMatch(/--pr-merged:\s*color-mix\(in oklab, var\(--vscode-charts-purple\) \d+%, var\(--vscode-charts-blue\)\);/);
    for (const [name, css] of sheets) expect(css.replace(/--st-headless:[^;]*;/, '').replace(/--pr-merged:[^;]*;/, ''), name).not.toMatch(/charts-purple/);
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

describe('Session View glyphs', () => {
  it('a spark carries its own size — an SVG with only a viewBox fills its container, and in the Now card it was 860 px tall (a class may still resize it: CSS beats the attribute)', () => {
    const src = readFileSync(join(dir, 'session/main.ts'), 'utf8');
    const body = /function spark\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(src)?.[1] ?? '';
    expect(body).toMatch(/'svg', \{[^}]*\bwidth: 16\b[^}]*\bheight: 16\b/);
  });
});

describe('the Now strip — the card, kept in view while it is scrolled off', () => {
  const css = sheets[2]![1];
  it('adds no height and never takes the pointer, so nothing moves under the reader when it appears', () => {
    expect(css).toMatch(/\.nowpin \{[^}]*position: sticky;[^}]*height: 0;[^}]*pointer-events: none;/);
  });
  it('appears by a scroll-driven animation off the Now card — no script, so a rebuild cannot reset it', () => {
    expect(css).toMatch(/\.overview \{[^}]*timeline-scope: --now;/);
    expect(css).toMatch(/\.nowcard \{[^}]*view-timeline: --now block;/);
    expect(css).toMatch(/\.nowpin__in \{[^}]*animation-timeline: --now;/);
  });
  it('is not stilled by reduced motion — that rule would leave it hidden for good', () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/.exec(css)?.[0] ?? '';
    expect(reduced).toContain('.spark');                          // the block was found
    expect(reduced).not.toContain('.nowpin');
  });
});

describe('Session View layout', () => {
  const css = sheets[2]![1];
  it('is one column that cannot outgrow the window — a long session title (a first prompt) ellipsizes instead of stretching the header, timeline and pane past the edge', () => {
    expect(css).toMatch(/\.app \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
  });
  it('is a header over a body — the agent list is a rail down the left, and the timeline and the pane stack in the column beside it (D23)', () => {
    expect(css).toMatch(/\.app \{[^}]*grid-template-rows: auto minmax\(0, 1fr\);/);
    expect(css).toMatch(/\.body \{[^}]*--rail: clamp\(180px, 26vw, 320px\);[^}]*grid-template-columns: var\(--rail\) minmax\(0, 1fr\);/);   // --rail: the view overrides it once you have dragged the divider
    expect(css).toMatch(/\.main \{[^}]*grid-template-rows: auto 0 minmax\(0, 1fr\);/);   // timeline · a zero-height row for the divider · pane
    expect(css).toMatch(/\.main \{[^}]*min-width: 0;/);                // the column may shrink below its content, or a wide timeline widens the whole view
  });
  it('keeps the rail at any usable width: it stacks over the rest only in a view narrower than 480 px (it did below 760, which a tab beside the sidebar is)', () => {
    expect([...css.matchAll(/@media \(max-width: (\d+)px\)/g)].map(m => Number(m[1]))).toEqual([480]);
  });
  it('reserves the timeline\'s scrollbar, so the width it was drawn for is the width it has — a vertical scrollbar would otherwise add a horizontal one', () => {
    expect(css).toMatch(/\.timeline \{[^}]*scrollbar-gutter: stable;/);
  });
  it('lays the timeline out for its own column — the rail takes some of the view\'s width — measured once it is in the page', () => {
    const src = readFileSync(join(dir, 'session/main.ts'), 'utf8');
    expect(src).not.toMatch(/root\.clientWidth\b.*Math\.max\(360/);
    expect(src).toMatch(/clientWidth \|\| 900/);
  });
  it('draws an idle gap as a thin divider — 26 px, it was 46: a fold is not worth a wide band of the timeline (D24)', () => {
    expect(readFileSync(join(dir, 'session/main.ts'), 'utf8')).toMatch(/gapW = 26\b/);
  });
});

describe('Session View rail (D23)', () => {
  const css = sheets[2]![1];
  it('has a divider to drag: a hit area laid over the rail\'s border, so it takes no width of its own, and it only lights up when you aim at it', () => {
    expect(css).toMatch(/\.sash \{[^}]*touch-action: none;/);
    expect(css).toMatch(/\.sash--v \{[^}]*position: absolute;[^}]*left: calc\(var\(--rail\) - 1px\);[^}]*width: 5px;[^}]*cursor: col-resize;/);
    expect(css).toMatch(/\.sash:hover::before, \.sash:focus-visible::before, \.sash--drag::before \{ background: var\(--s-sash\); \}/);
    expect(tokens).toMatch(/--s-sash:\s*var\(--vscode-sash-hoverBorder/);
    expect(/@media \(max-width: 480px\) \{[\s\S]*?\n\}/.exec(css)?.[0] ?? '').toContain('.sash--v { display: none; }');   // stacked, there is no rail beside anything to resize
  });
  it('the timeline and the pane have a divider too: a zero-height row between them and a hit area that straddles it, so you can give either more height', () => {
    expect(css).toMatch(/\.sash--h \{[^}]*position: relative;[^}]*height: 5px;[^}]*margin-top: -2px;[^}]*cursor: row-resize;/);
    expect(css).toMatch(/\.sash--h::before \{[^}]*left: 0;[^}]*right: 0;/);
  });
  it('once you have set the timeline\'s height it is fixed — held, in CSS, between a couple of lanes and what leaves the pane room, so a resized window keeps it in range — and until then it is as tall as its lanes, up to a third of the view', () => {
    expect(css).toMatch(/\.main\[data-tl\] \{[^}]*grid-template-rows: clamp\(60px, var\(--tl\), calc\(100vh - 240px\)\) 0 minmax\(0, 1fr\);/);
    expect(css).toMatch(/\.main\[data-tl\] \.timeline \{ max-height: none; \}/);
    expect(css).toMatch(/\.timeline \{[^}]*max-height: 34vh;/);
  });
  it('an agent\'s row is smaller than the session\'s and a group\'s header: a smaller font, tighter lines and padding, a smaller model chip', () => {
    expect(css).toMatch(/\.row--sub \{[^}]*padding-block: 3px;[^}]*font-size: calc\(var\(--size\) - 1px\);[^}]*line-height: 1\.35;/);
    expect(css).toMatch(/\.row--sub \.chipm \{[^}]*height: 14px;/);
    expect(css).toMatch(/\.row--root \.row__name \{ font-weight: 600; \}/);
  });
  it('a group\'s header stays in view while its agents scroll under it — opaque, so they cannot show through', () => {
    expect(css).toMatch(/\.grp__head \{[^}]*position: sticky;[^}]*top: 0;[^}]*background: color-mix\(in srgb, var\(--s-fg\) 4\.5%, var\(--s-bg\)\);/);
  });
  it('stacked (narrow), the list takes 30% of the height above the timeline, so a saved timeline height is held lower — the pane must not be squeezed out by a height set in a wider tab', () => {
    const narrow = /@media \(max-width: 480px\) \{[\s\S]*?\n\}/.exec(css)?.[0] ?? '';
    expect(narrow).toMatch(/\.main\[data-tl\] \{ grid-template-rows: clamp\(60px, var\(--tl\), calc\(70vh - 240px\)\) 0 minmax\(0, 1fr\); \}/);
  });
  it('both dividers are in the page: the timeline\'s between the timeline and the pane, the rail\'s beside the rail — each a keyboard-operable separator', () => {
    const src = readFileSync(join(dir, 'session/main.ts'), 'utf8');
    expect(src).toMatch(/renderList\(\), renderSash\(RAIL\), h\('div', \{ class: 'main' \}, timeline, renderSash\(TL\), pane\)/);   // in Tab order: the list, its divider, then the timeline, its divider, the pane
    expect(src).toMatch(/role: 'separator', 'aria-orientation': sp\.cls === 'sash--v' \? 'vertical' : 'horizontal'/);
  });
  it('a drag ends however it ends — released, cancelled, capture lost, the window blurred, or a move with no button down — and a resize redraws even mid-drag', () => {
    const src = readFileSync(join(dir, 'session/main.ts'), 'utf8');
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) expect(src).toContain(`addEventListener('${ev}', endDrag)`);
    expect(src).toMatch(/e\.buttons === 0\) \{ endDrag\(\)/);
    expect(src).toContain("window.addEventListener('blur', endDrag)");
    expect(src).toMatch(/render\(true\)/);                                   // the resize handler: a snapshot waits for a drag, a resize does not
  });
  it('a row\'s second line is cut with an ellipsis rather than wrapped, so a narrow rail keeps two lines a row', () => {
    expect(css).toMatch(/\.row__meta-text \{[^}]*min-width: 0;[^}]*overflow: hidden;[^}]*white-space: nowrap;[^}]*text-overflow: ellipsis;/);
  });
});

describe('Session View row details (D25)', () => {
  const css = sheets[2]![1];
  const src = readFileSync(join(dir, 'session/main.ts'), 'utf8');
  it('a running row whose transcript has gone quiet shows its elapsed time in the stalled colour (the card says how long), and pointing at a row or a lane lights the other — without ever repainting the selected one', () => {
    expect(css).toMatch(/\.row__since--quiet \{ color: var\(--tx-stalled\); \}/);
    expect(css).toMatch(/\.row\.echo:not\(\[aria-current="true"\]\) \{ background: var\(--s-hover\); \}/);
    expect(css).toMatch(/\.tl-hit\.echo:not\(\.tl-hit--sel\) \{ fill: color-mix\(in srgb, var\(--s-fg-editor\) 5%, transparent\); \}/);
  });
  it('the timeline marks a workflow with the IDE\'s own glyph, and an idle band answers a hover even when its label found no room', () => {
    expect(css).toMatch(/\.tl-glyph \{[^}]*font: 12px codicon;/);
    expect(css).toMatch(/\.tl-gap-hit \{ fill: transparent; \}/);
    expect(src).toContain("gl.textContent = '\\uebb9'");                      // codicon type-hierarchy, as an SVG text node (an SVG cannot use the font's CSS classes)
  });
  it('the pane\'s Task heading wears a small badge for who wrote it — the harness frame no longer sits in the text', () => {
    expect(css).toMatch(/\.sec__badge \{[^}]*text-transform: none;/);
  });
  it('a group\'s header line is cut with an ellipsis, not wrapped — the wall-clock is the first thing to go — and the whole of it is the tooltip', () => {
    expect(css).toMatch(/\.grp__meta \{[^}]*white-space: nowrap;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;/);
    expect(src).toMatch(/class: 'grp__meta', title: /);
  });
  it('a name that is verb:subject shrinks its verb first, so eight rows of "understand:…" stay eight different rows', () => {
    expect(css).toMatch(/\.row__verb \{[^}]*flex: 0 1 auto;[^}]*min-width: 1\.2em;[^}]*text-overflow: ellipsis;/);
    // the subject never flex-shrinks — a proportional share, however small, would cost it its last letters to an ellipsis — and is capped at what the verb's stub leaves
    expect(css).toMatch(/\.row__subject \{[^}]*flex: 0 0 auto;[^}]*max-width: calc\(100% - 1\.2em\);[^}]*text-overflow: ellipsis;/);
    expect(src).toMatch(/splitLabel\(n\.label\)/);
    expect(src).toMatch(/fitLabel\(name, max\)/);
  });
  it('a click on a row quiets its card until the pointer leaves it, and keyboard focus — not the focus a click leaves — opens it', () => {
    expect(src).toMatch(/quietRow = row \? row\.dataset\.id/);
    expect(src).toMatch(/if \(row\) clearTimeout\(showT\);/);                 // the pause that began before the click must not fire after it
    expect(src).toMatch(/if \(row\.dataset\.id === quietRow\) return;/);       // and no path — a timer, a rebuild, a focus — opens the card of the row you just clicked
    expect(src).toMatch(/if \(el\) quietRow = null;/);                         // only another row or file name ends the quiet, not the boundary events a rebuild fires
    expect(src).toMatch(/isRow\(el\) && el\.dataset\.id === quietRow/);
    expect(src).toMatch(/!isRow\(el\) \|\| el\.matches\(':focus-visible'\)/);
  });
  it('a row\'s hover card is the file card with other contents: a status-coloured line, a quiet note, and the task in a block cut at about nine lines', () => {
    expect(css).toMatch(/\.ncard__when--ok \{ color: var\(--tx-ok\); \}/);
    expect(css).toMatch(/\.ncard__quiet \{ color: var\(--tx-stalled\); \}/);
    expect(css).toMatch(/\.ncard__text \{[^}]*white-space: pre-wrap;[^}]*max-height: 9\.5em;[^}]*overflow: hidden;/);
  });
  it('the card opens after a short pause on a rail row, beside the rail, and follows the row through a rebuild — a lane tooltip lives on the lane\'s hit area, since its label takes no pointer', () => {
    expect(src).toMatch(/closest<HTMLElement>\('\.fp, \.list \.row'\)/);
    expect(src).toMatch(/isRow\(el\) \? 320 : 260/);
    expect(src).toMatch(/echo\(echoId\); refreshNodeCard\(\);/);
    expect(src).toMatch(/tip\.textContent = laneTip\(n, now\); hit\.append\(tip\)/);
    expect(src).not.toMatch(/nodeMeta/);                                      // the native row tooltip the card replaces
  });
});
