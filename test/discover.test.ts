import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discover } from '../src/core/discover.js';

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ccsf-'));
  mkdirSync(join(root, '-w-aida'), { recursive: true });
  writeFileSync(join(root, '-w-aida', 'aaaa-1111.jsonl'), '{}\n');
  mkdirSync(join(root, '-w-aida', 'aaaa-1111', 'subagents'), { recursive: true });
  writeFileSync(join(root, '-w-aida', 'aaaa-1111', 'subagents', 'agent-x.jsonl'), '{}\n');
  // must be ignored: not a .jsonl, and a tool-results sidecar
  mkdirSync(join(root, '-w-aida', 'aaaa-1111', 'tool-results'), { recursive: true });
  writeFileSync(join(root, '-w-aida', 'aaaa-1111', 'tool-results', 'x.txt'), 'noise');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('discover', () => {
  it('finds top-level sessions and subagent transcripts, ignores sidecars', async () => {
    const found = await discover(root);
    expect(found).toHaveLength(2);
    const session = found.find(f => f.kind === 'session')!;
    const sub = found.find(f => f.kind === 'subagent')!;
    expect(session.sessionId).toBe('aaaa-1111');
    expect(session.projectDir).toBe('-w-aida');
    expect(sub.sessionId).toBe('aaaa-1111');   // attributed to the PARENT (spec §6)
    expect(sub.size).toBeGreaterThan(0);
  });

  it('returns an empty list when the root does not exist', async () => {
    expect(await discover(join(root, 'nope'))).toEqual([]);
  });
});
