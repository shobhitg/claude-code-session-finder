// The single definition of path equality for this extension. Task 9's baton and
// Task 7's planner MUST both use it: if they disagree, a hand-off writes a baton
// the target window refuses to claim, and the click does nothing at all.

/**
 * macOS hands back NFD from some filesystem APIs and its default APFS volume is
 * case-insensitive. Claude Code normalizes with
 * `process.platform === 'darwin' ? p.normalize('NFC') : p`; we match that and
 * additionally fold case on darwin so two spellings of one real folder compare equal.
 * Linux is left byte-exact.
 */
export function normalizePath(p: string, platform: NodeJS.Platform = process.platform): string {
  const trimmed = p.length > 1 ? p.replace(/\/+$/, '') : p;
  return platform === 'darwin' ? trimmed.normalize('NFC').toLowerCase() : trimmed;
}

export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return normalizePath(a, platform) === normalizePath(b, platform);
}

/** True when `child` is `parent` or lives beneath it. Segment-aware: /w/ab is NOT inside /w/a. */
export function isInside(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const c = normalizePath(child, platform);
  const p = normalizePath(parent, platform);
  return c === p || c.startsWith(p.endsWith('/') ? p : p + '/');
}
