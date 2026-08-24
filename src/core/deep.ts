import { readFile } from 'node:fs/promises';
import type { SearchIndex } from './types.js';
import type { ParsedQuery, SessionHit } from './query.js';
import { snippet } from './query.js';

/**
 * Live scan of raw transcript text, including tool calls and results.
 * Deliberately NOT cached (spec §7) — this keeps the persistent index at ~6 MB
 * instead of ~170 MB, at the cost of ~0.5 s on the rare path.
 */
export async function deepSearch(
  index: SearchIndex, q: ParsedQuery, now: number,
  readFileFn: (p: string) => Promise<string> = p => readFile(p, 'utf8'),
): Promise<SessionHit[]> {
  const needles = q.phrase ? [q.phrase] : q.terms;
  if (!needles.length) return [];

  const candidates = index.sessions.filter(m => q.sinceMs === null || m.lastTs >= q.sinceMs);
  const hits: SessionHit[] = [];

  await Promise.all(candidates.map(async session => {
    const text = (await readFileFn(session.file).catch(() => '')).toLowerCase();
    if (!text) return;
    let count = 0, at = -1;
    for (const n of needles) {
      const i = text.indexOf(n);
      if (i < 0) return;                                  // AND semantics, same as prose search
      count++; if (at < 0) at = i;
    }
    hits.push({
      session, score: count, matchCount: count,
      best: { text: snippet(text, at, 60), role: 'a', index: 0 },
    });
  }));

  return hits.sort((a, b) => b.session.lastTs - a.session.lastTs);
}
