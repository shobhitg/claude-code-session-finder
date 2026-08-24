import { readFile } from 'node:fs/promises';
import type { SearchIndex, SessionMeta } from './types.js';
import type { ParsedQuery, SessionHit } from './query.js';
import { snippet } from './query.js';

/**
 * Files read concurrently. A `Promise.all` over the whole corpus peaked at 830 MB for a
 * single scan; chunking makes peak memory scale with the chunk, not with the corpus.
 */
const CHUNK = 8;
/** How much raw text around a hit is kept for the snippet. Never re-scan the whole file. */
const SNIPPET_PAD = 200;

export interface DeepOptions {
  readFileFn?: (p: string) => Promise<string>;
  /**
   * Polled between chunks AND between files. A superseded query or a disposed Quick Pick
   * must stop the scan RUNNING, not merely stop it rendering — see C1.
   */
  cancelled?: () => boolean;
  chunkSize?: number;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Live scan of raw transcript text, including tool calls and results.
 * Deliberately NOT cached (spec §7) — this keeps the persistent index at ~6 MB
 * instead of ~170 MB, at the cost of ~0.7 s on the rare path.
 */
export async function deepSearch(
  index: SearchIndex, q: ParsedQuery, now: number, opts: DeepOptions = {},
): Promise<SessionHit[]> {
  const readFileFn = opts.readFileFn ?? ((p: string) => readFile(p, 'utf8'));
  const cancelled = opts.cancelled ?? (() => false);
  const chunkSize = opts.chunkSize ?? CHUNK;

  // Case-insensitivity comes from the regex flag, never from text.toLowerCase(): that
  // second full-string copy doubled the peak for every file held in flight.
  const needles = (q.phrase ? [q.phrase] : q.terms).map(n => new RegExp(escapeRe(n), 'i'));
  if (!needles.length) return [];

  const candidates = index.sessions.filter(m => q.sinceMs === null || m.lastTs >= q.sinceMs);
  // I4: subagent transcripts are 43% of the corpus by bytes and are exactly where builds,
  // greps and test runs happen. Scan them too, attributed to the parent session — the same
  // rule discover() uses. extraFiles is assembled by cache.ts from the `files` map.
  const tasks: Array<{ session: SessionMeta; file: string }> = [];
  for (const session of candidates) {
    for (const file of [session.file, ...session.extraFiles]) tasks.push({ session, file });
  }

  const hits = new Map<string, SessionHit>();
  for (let i = 0; i < tasks.length; i += chunkSize) {
    if (cancelled()) break;
    await Promise.all(tasks.slice(i, i + chunkSize).map(async ({ session, file }) => {
      if (cancelled() || hits.has(session.sessionId)) return;
      const text = await readFileFn(file).catch(() => '');
      if (!text || cancelled()) return;
      let at = -1;
      for (const n of needles) {                          // AND semantics, same as prose search
        const found = text.search(n);
        if (found < 0) return;
        if (at < 0) at = found;
      }
      const from = Math.max(0, at - SNIPPET_PAD);
      hits.set(session.sessionId, {
        session, score: needles.length, matchCount: needles.length,
        best: { text: snippet(text.slice(from, at + SNIPPET_PAD), at - from, 60), role: 'a', index: 0 },
      });
    }));
  }

  return [...hits.values()].sort((a, b) => b.session.lastTs - a.session.lastTs);
}
