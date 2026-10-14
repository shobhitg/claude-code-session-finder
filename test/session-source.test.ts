import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonlTails, SessionSource, SessionFeed, type Loaded } from '../src/core/session-source.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ccsf-src-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const line = (o: object): string => `${JSON.stringify(o)}\n`;

describe('JsonlTails', () => {
  it('reads only what was appended since the last read', async () => {
    const f = join(root, 'a.jsonl');
    writeFileSync(f, line({ uuid: '1', pad: 'x'.repeat(100_000) }));
    const t = new JsonlTails();
    expect((await t.read(f))!.file.recs).toHaveLength(1);
    const first = t.bytesRead;
    const more = line({ uuid: '2' });
    appendFileSync(f, more);
    const r = (await t.read(f))!;
    expect(r.changed).toBe(true);
    expect(r.file.recs.map(x => x.uuid)).toEqual(['1', '2']);
    expect(t.bytesRead - first).toBe(Buffer.byteLength(more));
  });

  it('reports no change and reads nothing when the file is as it was', async () => {
    const f = join(root, 'a.jsonl');
    writeFileSync(f, line({ uuid: '1' }));
    const t = new JsonlTails();
    await t.read(f);
    const before = t.bytesRead;
    const r = (await t.read(f))!;
    expect(r.changed).toBe(false);
    expect(t.bytesRead).toBe(before);
  });

  it('leaves a line still being written for the next read, even mid-character', async () => {
    const f = join(root, 'a.jsonl');
    const whole = Buffer.from(line({ uuid: '2', text: 'café' }));
    const cut = whole.indexOf(Buffer.from('é')) + 1;                // inside the two bytes of é
    writeFileSync(f, Buffer.concat([Buffer.from(line({ uuid: '1' })), whole.subarray(0, cut)]));
    const t = new JsonlTails();
    expect((await t.read(f))!.file.recs.map(x => x.uuid)).toEqual(['1']);
    appendFileSync(f, whole.subarray(cut));
    const recs = (await t.read(f))!.file.recs as Array<{ uuid?: string; text?: string }>;
    expect(recs.map(x => x.uuid)).toEqual(['1', '2']);
    expect(recs[1]!.text).toBe('café');
  });

  it('takes a complete last line that has no newline, once', async () => {
    const f = join(root, 'a.jsonl');
    writeFileSync(f, `${line({ uuid: '1' })}${JSON.stringify({ uuid: '2' })}`);
    const t = new JsonlTails();
    expect((await t.read(f))!.file.recs.map(x => x.uuid)).toEqual(['1', '2']);
    appendFileSync(f, `\n${line({ uuid: '3' })}`);
    expect((await t.read(f))!.file.recs.map(x => x.uuid)).toEqual(['1', '2', '3']);
  });

  it('starts again from the top when the file shrank', async () => {
    const f = join(root, 'a.jsonl');
    writeFileSync(f, line({ uuid: '1' }) + line({ uuid: '2' }));
    const t = new JsonlTails();
    await t.read(f);
    writeFileSync(f, line({ uuid: '9' }));
    expect((await t.read(f))!.file.recs.map(x => x.uuid)).toEqual(['9']);
  });

  it('takes a touch (same size, new mtime) as a change without reading anything', async () => {
    const f = join(root, 'a.jsonl');
    writeFileSync(f, line({ uuid: '1' }));
    const t = new JsonlTails();
    await t.read(f);
    const before = t.bytesRead;
    const later = new Date(Date.now() + 5_000); utimesSync(f, later, later);
    const r = (await t.read(f))!;
    expect(r.changed).toBe(true);
    expect(r.file.recs).toHaveLength(1);
    expect(t.bytesRead).toBe(before);
  });

  it('is undefined for a file that is gone', async () => {
    expect(await new JsonlTails().read(join(root, 'nope.jsonl'))).toBeUndefined();
  });
});

function session(sessionId = 'sess-1'): { main: string; sub: (proj: string, ...rel: string[]) => string } {
  mkdirSync(join(root, '-w-proj'), { recursive: true });
  const main = join(root, '-w-proj', `${sessionId}.jsonl`);
  writeFileSync(main, line({ type: 'user', uuid: 'm1', timestamp: '2026-10-14T10:00:00Z', message: { role: 'user', content: 'go' } }));
  const sub = (proj: string, ...rel: string[]): string => {
    const p = join(root, proj, sessionId, 'subagents', ...rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, line({ type: 'user', uuid: `${rel.join('/')}`, isSidechain: true, message: { role: 'user', content: 'task' } }));
    return p;
  };
  return { main, sub };
}

describe('SessionSource', () => {
  it("finds this session's agents in any project dir, with workflow journals, and no other session's", async () => {
    const { main, sub } = session();
    sub('-w-proj', 'agent-a1.jsonl');
    sub('-w-other', 'workflows', 'wf_1', 'agent-b2.jsonl');
    sub('-w-other', 'workflows', 'wf_1', 'journal.jsonl');
    mkdirSync(join(root, '-w-proj', 'sess-2', 'subagents'), { recursive: true });
    writeFileSync(join(root, '-w-proj', 'sess-2', 'subagents', 'agent-zz.jsonl'), line({ uuid: 'other' }));
    const l = (await new SessionSource('sess-1', main, root).load())!;
    expect(l.agents.map(a => a.agentId).sort()).toEqual(['a1', 'b2']);
    expect(l.agents.find(a => a.agentId === 'b2')!.runId).toBe('wf_1');
    expect(Object.keys(l.journals)).toEqual(['wf_1']);
    expect(l.changed.size).toBe(4);                                   // main, two agents, the journal
  });

  it('reads nothing on a load where nothing changed, however many agents there are', async () => {
    const { main, sub } = session();
    for (let i = 0; i < 200; i++) sub('-w-proj', 'workflows', `wf_${i % 5}`, `agent-${i}.jsonl`);
    const src = new SessionSource('sess-1', main, root);
    await src.load();
    const before = src.tails.bytesRead;
    const again = (await src.load())!;
    expect(again.changed.size).toBe(0);
    expect(src.tails.bytesRead).toBe(before);
    appendFileSync(join(root, '-w-proj', 'sess-1', 'subagents', 'workflows', 'wf_3', 'agent-3.jsonl'), line({ uuid: 'new' }));
    expect([...(await src.load())!.changed]).toEqual([join(root, '-w-proj', 'sess-1', 'subagents', 'workflows', 'wf_3', 'agent-3.jsonl')]);
    expect(src.tails.bytesRead - before).toBe(Buffer.byteLength(line({ uuid: 'new' })));
  });

  it("lets go of an agent's records once its transcript is gone", async () => {
    const { main, sub } = session();
    const a = sub('-w-proj', 'agent-a1.jsonl');
    const src = new SessionSource('sess-1', main, root);
    await src.load();
    expect(src.recs(a)).toHaveLength(1);
    rmSync(a);
    expect((await src.load())!.agents).toHaveLength(0);
    expect(src.recs(a)).toBeUndefined();
  });

  it('is undefined once the main transcript is gone', async () => {
    expect(await new SessionSource('sess-1', join(root, 'gone.jsonl'), root).load()).toBeUndefined();
  });
});

describe('SessionFeed', () => {
  function feed(main: string, live = true): { feed: SessionFeed; sent: Array<'init' | 'update'>; seqs: number[]; missing: number[]; throwing: { on: boolean } } {
    const sent: Array<'init' | 'update'> = []; const seqs: number[] = []; const missing: number[] = []; const throwing = { on: false };
    const f = new SessionFeed(new SessionSource('sess-1', main, root), {
      live: () => live,
      send: (_: Loaded, kind, seq) => { if (throwing.on) throw new Error('bad record'); sent.push(kind); seqs.push(seq); },
      missing: () => { missing.push(1); },
    });
    return { feed: f, sent, seqs, missing, throwing };
  }
  const ackLast = (f: SessionFeed, seqs: number[]): void => f.ack(seqs[seqs.length - 1]!);
  const grow = (main: string, i: number): void => { appendFileSync(main, line({ type: 'user', uuid: `t${i}` })); };

  it('holds at most one update for a webview that never acknowledges, however many ticks pass', async () => {
    const { main } = session();
    const { feed: f, sent } = feed(main);
    for (let i = 0; i < 50; i++) { grow(main, i); await f.tick(); }
    expect(sent).toEqual(['update']);
    expect(f.waiting).toBe(true);
  });

  it('sends the next change once the last one is acknowledged — the changes made meanwhile included', async () => {
    const { main } = session();
    const { feed: f, sent, seqs } = feed(main);
    await f.load(true);
    grow(main, 1); await f.tick();
    expect(sent).toEqual(['init']);
    ackLast(f, seqs);
    await f.tick();
    expect(sent).toEqual(['init', 'update']);
    ackLast(f, seqs);
    await f.tick();                                                   // nothing new
    expect(sent).toEqual(['init', 'update']);
  });

  it("does not take an older update's acknowledgement for the latest one's", async () => {
    const { main } = session();
    const { feed: f, sent, seqs } = feed(main);
    await f.load(true);                                               // init 1
    f.resend();                                                       // init 2: the webview restarted
    f.ack(seqs[0]!);                                                  // the first one's ack arrives late
    grow(main, 1); await f.tick();
    expect(sent).toEqual(['init', 'init']);
    f.ack(seqs[1]!);
    await f.tick();
    expect(sent).toEqual(['init', 'init', 'update']);
  });

  it('keeps ticking when building an update throws', async () => {
    const { main } = session();
    const { feed: f, sent, throwing } = feed(main);
    throwing.on = true;
    grow(main, 1); await expect(f.tick()).rejects.toThrow('bad record');
    throwing.on = false;
    expect(f.waiting).toBe(false);
    await f.load(true);
    expect(sent).toEqual(['init']);
  });

  it('does not read a session that is not live', async () => {
    const { main } = session();
    const { feed: f, sent } = feed(main, false);
    grow(main, 1); await f.tick();
    expect(sent).toEqual([]);
  });

  it("resends the last snapshot when the webview restarts, and says when the transcript is gone", async () => {
    const { main } = session();
    const { feed: f, sent, seqs, missing } = feed(main);
    f.resend();
    expect(sent).toEqual([]);                                         // nothing loaded yet: the first load posts
    await f.load(true); ackLast(f, seqs);
    f.resend();
    expect(sent).toEqual(['init', 'init']);
    rmSync(main); ackLast(f, seqs);
    expect(statSync(root).isDirectory()).toBe(true);
    await f.tick();
    expect(missing).toHaveLength(1);
  });
});
