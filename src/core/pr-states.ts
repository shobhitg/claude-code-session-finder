// What GitHub says about the PRs the sidebar shows — open, merged, closed or draft, and each one's title
// and head branch — and when to ask again. Pure; src/pr-states.ts asks GitHub (through `gh`) and keeps the cache.
import type { PrInfo, PrState } from './rows.js';

/** No `state`: GitHub has no such PR, or this account cannot see it. */
export interface PrCacheEntry { at: number; state?: PrState; title?: string; head?: string }
export type PrCache = Record<string, PrCacheEntry>;
export interface PrRef { repo: string; n: number }

export const prKey = (repo: string, n: number): string => `${repo}#${n}`;

const MIN = 60_000;
/** An open PR can merge or close at any time; one GitHub said nothing about might be one we cannot see yet. Merged and closed are final. */
const ASK_AGAIN_MS = { open: 10 * MIN, draft: 10 * MIN, missing: 24 * 60 * MIN } as const;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The PRs worth asking GitHub about now, once each, in the order given: github.com ones whose repo is known. */
export function stalePrs(prs: ReadonlyArray<{ repo: string | null; n: number; url: string | null }>, cache: PrCache, now: number): PrRef[] {
  const out: PrRef[] = []; const seen = new Set<string>();
  for (const p of prs) {
    if (!p.repo || !REPO.test(p.repo) || (p.url && !p.url.startsWith('https://github.com/'))) continue;
    const key = prKey(p.repo, p.n);
    if (seen.has(key)) continue;
    seen.add(key);
    const had = cache[key];
    const wait = !had ? 0 : had.state === 'merged' || had.state === 'closed' ? Infinity : ASK_AGAIN_MS[had.state ?? 'missing'];
    if (now - (had?.at ?? 0) >= wait) out.push({ repo: p.repo, n: p.n });
  }
  return out;
}

/** One GraphQL query for all of them: a `repository` per repo, a `pullRequest` per number. */
export function prQuery(prs: readonly PrRef[]): string {
  const repos = [...new Set(prs.map(p => p.repo))];
  const fields = 'state isDraft title headRefName';
  return `query { ${repos.map((repo, i) => {
    const [owner, name] = repo.split('/');
    const pulls = [...new Set(prs.filter(p => p.repo === repo).map(p => p.n))].map(n => `p${n}: pullRequest(number: ${n}) { ${fields} }`);
    return `r${i}: repository(owner: "${owner}", name: "${name}") { ${pulls.join(' ')} }`;
  }).join(' ')} }`;
}

interface PullNode { state?: string; isDraft?: boolean; title?: string; headRefName?: string }
const STATES: Record<string, PrState> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' };

/** The answer to prQuery(asked), as cache entries — every PR asked about gets one, even those GitHub said nothing about. */
export function readPrStates(data: unknown, asked: readonly PrRef[], now: number): PrCache {
  const repos = [...new Set(asked.map(p => p.repo))];
  const out: PrCache = {};
  for (const p of asked) {
    const repo = (data as Record<string, Record<string, PullNode | null> | null> | null)?.[`r${repos.indexOf(p.repo)}`];
    const node = repo?.[`p${p.n}`];
    const state = node?.state ? STATES[node.state] : undefined;
    out[prKey(p.repo, p.n)] = !node || !state ? { at: now }
      : { at: now, state: state === 'open' && node.isDraft ? 'draft' : state,
          ...(node.title ? { title: node.title } : {}), ...(node.headRefName ? { head: node.headRefName } : {}) };
  }
  return out;
}

export function prInfoOf(e: PrCacheEntry | undefined): PrInfo | undefined {
  if (!e?.state) return undefined;
  return { state: e.state, ...(e.title ? { title: e.title } : {}), ...(e.head ? { head: e.head } : {}) };
}

/** The `keep` most recently asked entries: the cache lives in global state and must not grow forever. */
export function prunePrCache(cache: PrCache, keep: number): PrCache {
  return Object.fromEntries(Object.entries(cache).sort(([, a], [, b]) => b.at - a.at).slice(0, keep));
}
