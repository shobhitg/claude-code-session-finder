import type { SearchIndex, SessionMeta, Role } from './types.js';

export interface ParsedQuery {
  terms: string[]; phrase: string | null; pr: number | null;
  sinceMs: number | null; deep: boolean; raw: string;
}

const DAY = 86_400_000;
const UNIT: Record<string, number> = { d: DAY, w: 7 * DAY, m: 30 * DAY };

/** null = explicit "all time"; undefined = unparseable (caller should fall back) */
function windowToMs(spec: string, now: number): number | null | undefined {
  const s = spec.trim().toLowerCase();
  if (!s || s === 'all') return null;
  const m = /^(\d+)([dwm])?$/.exec(s);
  if (!m) return undefined;
  return now - Number(m[1]) * (UNIT[m[2] ?? 'd'] ?? DAY);
}

/** Resolve a since: spec, falling back to defaultWindow when spec is unparseable. */
function resolveSince(spec: string, defaultWindow: string, now: number): number | null {
  const primary = windowToMs(spec, now);
  if (primary !== undefined) return primary;
  const fallback = windowToMs(defaultWindow, now);
  return fallback === undefined ? null : fallback;
}

export function parseQuery(input: string, defaultWindow: string, now: number): ParsedQuery {
  const raw = input;
  let rest = input.trim();
  const deep = rest.startsWith('!');
  if (deep) rest = rest.slice(1).trim();

  let phrase: string | null = null;
  const openIdx = rest.indexOf('"');
  if (openIdx >= 0) {
    const closeIdx = rest.indexOf('"', openIdx + 1);
    if (closeIdx >= 0) {
      const inner = rest.slice(openIdx + 1, closeIdx);
      phrase = inner.length ? inner.toLowerCase() : null;
      rest = rest.slice(0, openIdx) + ' ' + rest.slice(closeIdx + 1);
    } else {
      // Unterminated quote: treat as a phrase still being typed.
      const inner = rest.slice(openIdx + 1).trim();
      phrase = inner.length ? inner.toLowerCase() : null;
      rest = rest.slice(0, openIdx);
    }
  }
  // Only the first quote-delimited (or unterminated) region becomes the phrase;
  // any further " characters are noise and must never reach the term tokenizer.
  rest = rest.replace(/"/g, ' ');

  let pr: number | null = null;
  rest = rest.replace(/(?:^|\s)pr:#?(\d+)(?=\s|$)/i, (_, n: string) => { pr = Number(n); return ' '; });

  let sinceSpec: string | null = null;
  rest = rest.replace(/(?:^|\s)since:(\S+)(?=\s|$)/i, (_, v: string) => { sinceSpec = v; return ' '; });

  return {
    raw, deep, phrase, pr,
    sinceMs: resolveSince(sinceSpec ?? defaultWindow, defaultWindow, now),
    terms: rest.toLowerCase().split(/\s+/).filter(Boolean),
  };
}

const ROLE_WEIGHT: Record<Role, number> = { t: 3.0, u: 2.0, a: 1.0, sub: 0.7 };

/** exact phrase 3.0 · all terms within a 40-char span 2.0 · all terms present 1.0 · else 0 */
function matchQuality(lower: string, q: ParsedQuery): { score: number; at: number } {
  if (q.phrase) { const at = lower.indexOf(q.phrase); return { score: at >= 0 ? 3.0 : 0, at: Math.max(at, 0) }; }
  if (!q.terms.length) return { score: 0, at: 0 };
  const positions: number[] = [];
  for (const t of q.terms) { const at = lower.indexOf(t); if (at < 0) return { score: 0, at: 0 }; positions.push(at); }
  const lo = Math.min(...positions), hi = Math.max(...positions);
  return { score: hi - lo <= 40 ? 2.0 : 1.0, at: lo };
}

const recencyBoost = (t: number, now: number) => 1 + 0.5 * Math.exp(-Math.max(0, now - t) / (14 * DAY));

export interface SessionHit {
  session: SessionMeta; score: number; matchCount: number;
  best: { text: string; role: Role; index: number } | null;
}

export function search(index: SearchIndex, q: ParsedQuery, now: number): SessionHit[] {
  const inWindow = (m: SessionMeta) => q.sinceMs === null || m.lastTs >= q.sinceMs;

  if (q.pr !== null) {
    return index.sessions
      .filter(m => m.prLinks.includes(q.pr!) && inWindow(m))
      .map(session => ({ session, score: 1000, matchCount: 1, best: null }));
  }
  if (!q.terms.length && !q.phrase) return [];

  const acc = new Map<number, { score: number; count: number; best: SessionHit['best'] }>();
  for (const p of index.prose) {
    const session = index.sessions[p.s];
    if (!session || !inWindow(session)) continue;
    const { score: quality, at } = matchQuality(p.x.toLowerCase(), q);
    if (!quality) continue;
    const score = quality * ROLE_WEIGHT[p.r] * recencyBoost(p.t, now);
    const cur = acc.get(p.s);
    if (!cur) acc.set(p.s, { score, count: 1, best: { text: p.x, role: p.r, index: at } });
    else {
      cur.count++;
      if (score > cur.score) { cur.score = score; cur.best = { text: p.x, role: p.r, index: at }; }
    }
  }

  return [...acc.entries()]
    .map(([s, v]) => ({
      session: index.sessions[s]!,
      score: v.score + 0.3 * Math.log1p(v.count),
      matchCount: v.count, best: v.best,
    }))
    .sort((a, b) => b.score - a.score || b.session.lastTs - a.session.lastTs);
}

export function snippet(text: string, at: number, pad = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const clampedAt = Math.min(Math.max(at, 0), flat.length);
  const start = Math.max(0, clampedAt - pad), end = Math.min(flat.length, clampedAt + pad);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}
