import { describe, it, expect } from 'vitest';
import { rings, stampLooks, mergeLooks, pruneLooks, parseLooks, LooksFile, Bell, LOOKS_KEEP_MS, type Looks } from '../src/core/looks.js';
import type { Liveness, LiveState } from '../src/core/state.js';

const MIN = 60_000, H = 60 * MIN;
const T = 1_000 * H;
const turn: LiveState = { kind: 'attention', reason: 'your-turn' };
const question: LiveState = { kind: 'attention', reason: 'question' };
const tool: LiveState = { kind: 'attention', reason: 'tool-or-permission' };
const interrupted: LiveState = { kind: 'attention', reason: 'interrupted' };
const stalled: LiveState = { kind: 'attention', reason: 'stalled' };
const running: LiveState = { kind: 'running' };
const lv = (sessionId: string, state: LiveState, lastWriteMs: number): Liveness => ({ sessionId, verdict: 'turn-ended', state, lastWriteMs });
const looks = (at: Record<string, number> = {}, since = 0): Looks => ({ since, at });

describe('rings: the bell rings while the ball is in your court and you have not seen it there', () => {
  it('your turn, an interruption and a quiet tool call ring until you look after they land', () => {
    for (const s of [turn, interrupted, tool]) {
      expect(rings(lv('a', s, T), looks()), s.kind === 'attention' ? s.reason : '').toBe(true);
      expect(rings(lv('a', s, T), looks({ a: T - 1 }))).toBe(true);          // looked before it landed
      expect(rings(lv('a', s, T), looks({ a: T }))).toBe(false);
      expect(rings(lv('a', s, T), looks({ a: T + MIN }))).toBe(false);
      expect(rings(lv('a', s, T), looks({ b: T + MIN }))).toBe(true);        // somebody else's look
    }
  });
  it('a question is sticky: it rings until Claude moves again, looked at or not', () => {
    expect(rings(lv('a', question, T), looks({ a: T + H }))).toBe(true);
    expect(rings(lv('a', question, T), looks({}, T + H))).toBe(true);
  });
  it('never while Claude works, nor for a stalled session — the ball is not with you', () => {
    expect(rings(lv('a', running, T), looks())).toBe(false);
    expect(rings(lv('a', stalled, T), looks())).toBe(false);
  });
  it('nothing written before the looks began rings (the first run after an upgrade)', () => {
    expect(rings(lv('a', turn, T), looks({}, T + MIN))).toBe(false);
    expect(rings(lv('a', turn, T + 2 * MIN), looks({}, T + MIN))).toBe(true);
  });
});

describe('stampLooks: a look counts only while the ball is in your court', () => {
  it('stamps a session on screen that is waiting on you with an older stamp, and nothing else', () => {
    const live = new Map([
      ['turn', lv('turn', turn, T)], ['run', lv('run', running, T)], ['fresh', lv('fresh', turn, T)], ['away', lv('away', turn, T)],
    ]);
    const before = looks({ fresh: T + 5, away: 1 });
    const after = stampLooks(before, ['turn', 'run', 'fresh', 'ghost'], live, T + MIN);
    expect(after.at).toEqual({ turn: T + MIN, fresh: T + 5, away: 1 });     // run is working; fresh already seen; ghost is not live
    expect(before.at).toEqual({ fresh: T + 5, away: 1 });                    // not mutated
  });
  it('returns the same object when nothing changes, so the caller knows not to write', () => {
    const l = looks({ a: T + 1 });
    expect(stampLooks(l, ['a'], new Map([['a', lv('a', turn, T)]]), T + MIN)).toBe(l);
    expect(stampLooks(l, [], new Map([['b', lv('b', turn, T)]]), T + MIN)).toBe(l);
  });
  it('a quiet tool call you watched turn quiet is seen; one that turned quiet after you looked away rings', () => {
    const watched = stampLooks(looks(), ['a'], new Map([['a', lv('a', tool, T)]]), T + MIN);   // on screen at the flip
    expect(rings(lv('a', tool, T), watched)).toBe(false);
    const away = stampLooks(looks(), ['a'], new Map([['a', lv('a', running, T)]]), T + 30_000); // on screen while it ran
    expect(rings(lv('a', tool, T), away)).toBe(true);
  });
});

describe('mergeLooks / pruneLooks / parseLooks: the file every window shares', () => {
  it('merge keeps the later look per session and the later start', () => {
    expect(mergeLooks(looks({ a: 5, b: 1 }, 10), looks({ a: 3, c: 7 }, 20))).toEqual(looks({ a: 5, b: 1, c: 7 }, 20));
  });
  it('prune drops a session that is not live once its look is a week old; a live one is kept whatever its age', () => {
    const now = 100 * 24 * H;
    const l = looks({ gone: now - LOOKS_KEEP_MS - 1, recent: now - H, parked: 1 }, 5);
    expect(pruneLooks(l, new Set(['parked']), now)).toEqual(looks({ recent: now - H, parked: 1 }, 5));
  });
  it('parse accepts only the stored shape and drops bad entries', () => {
    expect(parseLooks('{"since":5,"at":{"a":7,"b":"x","c":null}}')).toEqual(looks({ a: 7 }, 5));
    for (const bad of ['', 'nope', '[]', '{"at":{}}', '{"since":"5","at":{}}', 'null']) expect(parseLooks(bad), bad).toBeNull();
  });
});

describe('LooksFile', () => {
  const fakeFs = (initial?: string) => {
    const files = new Map<string, string>(initial === undefined ? [] : [['/g/looks.json', initial]]);
    return {
      files,
      io: {
        read: (p: string) => { const s = files.get(p); if (s === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return s; },
        write: async (p: string, s: string) => { files.set(p, s); },
      },
    };
  };
  it('a missing file starts the looks now and writes that start down', async () => {
    const fs = fakeFs();
    const f = new LooksFile('/g/looks.json', fs.io);
    expect(f.read(T)).toEqual(looks({}, T));
    await f.save(looks({ a: T + 1 }, T));
    expect(parseLooks(fs.files.get('/g/looks.json')!)).toEqual(looks({ a: T + 1 }, T));
  });
  it('a corrupt file is treated as missing', () => {
    expect(new LooksFile('/g/looks.json', fakeFs('{').io).read(T)).toEqual(looks({}, T));
  });
  it('save merges with what another window wrote meanwhile, so neither look is lost', async () => {
    const fs = fakeFs(JSON.stringify(looks({ a: 1 }, 5)));
    const f = new LooksFile('/g/looks.json', fs.io);
    const mine = f.read(T);
    fs.files.set('/g/looks.json', JSON.stringify(looks({ a: 1, other: 9 }, 5)));   // window B
    const saved = await f.save({ ...mine, at: { ...mine.at, me: 8 } });
    expect(saved).toEqual(looks({ a: 1, other: 9, me: 8 }, 5));
    expect(parseLooks(fs.files.get('/g/looks.json')!)).toEqual(saved);
  });
});

describe('Bell: what the host asks before every snapshot', () => {
  const setup = (initial?: Looks) => {
    const files = new Map<string, string>(initial ? [['/g/looks.json', JSON.stringify(initial)]] : []);
    let writes = 0;
    const io = {
      read: (p: string) => { const s = files.get(p); if (s === undefined) throw new Error('ENOENT'); return s; },
      write: async (p: string, s: string) => { writes++; files.set(p, s); },
    };
    let clock = T;
    const bell = new Bell(new LooksFile('/g/looks.json', io), () => clock);
    return { bell, files, writes: () => writes, advance: (ms: number) => { clock += ms; }, file: () => parseLooks(files.get('/g/looks.json')!)! };
  };
  const ids = (live: Map<string, Liveness>, r: (l: Liveness) => boolean) => [...live.values()].filter(r).map(l => l.sessionId);

  it('a reply that lands while its session is on screen never rings, not even for one snapshot', async () => {
    const b = setup(looks({}, 0));
    b.bell.setOnScreen(new Set(['a']));
    const live = new Map([['a', lv('a', turn, T - 1_000)], ['b', lv('b', turn, T - 1_000)]]);
    expect(ids(live, b.bell.update(live, true))).toEqual(['b']);
    await Promise.resolve();
    expect(b.file().at).toEqual({ a: T });                                  // written down for the other windows
  });
  it('an unfocused window records no look: a tab on screen behind another app is not being read', () => {
    const b = setup(looks({}, 0));
    b.bell.setOnScreen(new Set(['a']));
    const live = new Map([['a', lv('a', turn, T - 1_000)]]);
    expect(ids(live, b.bell.update(live, false))).toEqual(['a']);
    expect(ids(live, b.bell.update(live, true))).toEqual([]);              // focus came back with it on screen
  });
  it('setOnScreen says whether the set changed, so the host republishes only then', () => {
    const b = setup();
    expect(b.bell.setOnScreen(new Set(['a']))).toBe(true);
    expect(b.bell.setOnScreen(new Set(['a']))).toBe(false);
    expect(b.bell.setOnScreen(new Set())).toBe(true);
  });
  it('looking away does not un-see: a seen reply stays quiet; the next reply rings again', () => {
    const b = setup(looks({}, 0));
    b.bell.setOnScreen(new Set(['a']));
    b.bell.update(new Map([['a', lv('a', turn, T - 1_000)]]), true);
    b.bell.setOnScreen(new Set());
    b.advance(MIN);
    expect(ids(new Map([['a', lv('a', turn, T - 1_000)]]), b.bell.update(new Map([['a', lv('a', turn, T - 1_000)]]), true))).toEqual([]);
    const next = new Map([['a', lv('a', turn, T + 30_000)]]);
    expect(ids(next, b.bell.update(next, true))).toEqual(['a']);
  });
  it('writes only when a look is new — not on every snapshot while you watch', async () => {
    const b = setup(looks({}, 0));
    b.bell.setOnScreen(new Set(['a']));
    const live = new Map([['a', lv('a', turn, T - 1_000)]]);
    for (let i = 0; i < 5; i++) { b.bell.update(live, true); b.advance(2_000); }
    await Promise.resolve();
    expect(b.writes()).toBe(1);
  });
  it('reload takes in another window\'s looks (the host calls it when the window gains focus)', () => {
    const b = setup(looks({}, 0));
    const live = new Map([['a', lv('a', turn, T - 1_000)]]);
    expect(ids(live, b.bell.update(live, true))).toEqual(['a']);
    b.files.set('/g/looks.json', JSON.stringify(looks({ a: T }, 0)));      // window B saw it
    b.bell.reload();
    expect(ids(live, b.bell.update(live, true))).toEqual([]);
  });
  it('a first run starts the looks now: what finished before it stays quiet, a question still rings', () => {
    const b = setup();
    const live = new Map([['old', lv('old', turn, T - H)], ['q', lv('q', question, T - H)]]);
    expect(ids(live, b.bell.update(live, true))).toEqual(['q']);
    expect(b.file().since).toBe(T);
  });
});
