import { describe, it, expect } from 'vitest';
import { stalePrs, prQuery, readPrStates, prInfoOf, prunePrCache, prKey, type PrCache } from '../src/core/pr-states.js';

const MIN = 60_000;
const pr = (n: number, repo: string | null = 'acme/app', url: string | null = `https://github.com/${repo}/pull/${n}`) => ({ n, repo, url });

describe('stalePrs', () => {
  const now = 1_000 * MIN;
  const cache: PrCache = {
    [prKey('acme/app', 1)]: { at: now - 5 * MIN, state: 'open' },
    [prKey('acme/app', 2)]: { at: now - 11 * MIN, state: 'draft' },
    [prKey('acme/app', 3)]: { at: 0, state: 'merged' },
    [prKey('acme/app', 4)]: { at: 0, state: 'closed' },
    [prKey('acme/app', 5)]: { at: now - 2 * 60 * MIN },
    [prKey('acme/app', 6)]: { at: now - 25 * 60 * MIN },
  };

  it('asks about a PR never asked, an open or draft one after ten minutes, a missing one after a day — never a merged or closed one', () => {
    expect(stalePrs([1, 2, 3, 4, 5, 6, 7].map(n => pr(n)), cache, now)).toEqual([
      { repo: 'acme/app', n: 2 }, { repo: 'acme/app', n: 6 }, { repo: 'acme/app', n: 7 },
    ]);
  });

  it('asks once per PR, and only GitHub about a github.com repo it can name', () => {
    expect(stalePrs([pr(7), pr(7), pr(8, null), pr(9, 'acme/app', 'https://ghe.corp/acme/app/pull/9'), pr(10, 'not a repo'), pr(11, 'acme/app', null)], {}, now))
      .toEqual([{ repo: 'acme/app', n: 7 }, { repo: 'acme/app', n: 11 }]);
  });
});

describe('prQuery', () => {
  it('asks for every PR of every repo in one GraphQL query', () => {
    const q = prQuery([{ repo: 'acme/app', n: 1 }, { repo: 'acme/app', n: 2 }, { repo: 'acme/tools', n: 1 }]);
    expect(q).toBe('query { '
      + 'r0: repository(owner: "acme", name: "app") { p1: pullRequest(number: 1) { state isDraft title headRefName } p2: pullRequest(number: 2) { state isDraft title headRefName } } '
      + 'r1: repository(owner: "acme", name: "tools") { p1: pullRequest(number: 1) { state isDraft title headRefName } } }');
  });
});

describe('readPrStates', () => {
  it('reads state, draft, title and head; a PR GitHub has not got is remembered as missing', () => {
    const asked = [{ repo: 'acme/app', n: 1 }, { repo: 'acme/app', n: 2 }, { repo: 'acme/app', n: 3 }, { repo: 'acme/app', n: 4 }, { repo: 'acme/gone', n: 1 }];
    const data = {
      r0: {
        p1: { state: 'OPEN', isDraft: false, title: 'Nudge on all websites', headRefName: 'shobhit/all-websites-nudge' },
        p2: { state: 'OPEN', isDraft: true, title: 'WIP', headRefName: 'x' },
        p3: { state: 'MERGED', isDraft: false, title: 'Done', headRefName: 'y' },
        p4: null,
      },
      r1: null,
    };
    expect(readPrStates(data, asked, 7)).toEqual({
      'acme/app#1': { at: 7, state: 'open', title: 'Nudge on all websites', head: 'shobhit/all-websites-nudge' },
      'acme/app#2': { at: 7, state: 'draft', title: 'WIP', head: 'x' },
      'acme/app#3': { at: 7, state: 'merged', title: 'Done', head: 'y' },
      'acme/app#4': { at: 7 },
      'acme/gone#1': { at: 7 },
    });
  });
});

describe('prInfoOf / prunePrCache', () => {
  it('a missing PR has no info', () => {
    expect(prInfoOf({ at: 1 })).toBeUndefined();
    expect(prInfoOf({ at: 1, state: 'closed', title: 't', head: 'h' })).toEqual({ state: 'closed', title: 't', head: 'h' });
  });

  it('keeps the most recently asked entries', () => {
    const cache: PrCache = { a: { at: 1 }, b: { at: 3 }, c: { at: 2 } };
    expect(Object.keys(prunePrCache(cache, 2)).sort()).toEqual(['b', 'c']);
  });
});
