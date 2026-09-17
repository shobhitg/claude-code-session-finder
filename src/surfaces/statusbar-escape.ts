/**
 * Titles are user/AI text; escape markdown so a title cannot format — or theme-icon — the tooltip.
 * The set is deliberately broad (it includes `.`, `-`, `+`): VS Code's renderer shows `\.` as `.`,
 * so over-escaping is invisible, while under-escaping lets "v0.2.0 - *fix*" italicise the tooltip.
 */
export function mdEscape(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, m => `\\${m}`);
}
