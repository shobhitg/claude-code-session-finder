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
  // Deep nesting within subagents/ — should be discovered
  mkdirSync(join(root, '-w-aida', 'aaaa-1111', 'subagents', 'workflows', 'wf_abc'), { recursive: true });
  writeFileSync(join(root, '-w-aida', 'aaaa-1111', 'subagents', 'workflows', 'wf_abc', 'agent-1.jsonl'), '{}\n');
  // must be ignored: tool-results sidecar directory with .jsonl
  mkdirSync(join(root, '-w-aida', 'aaaa-1111', 'tool-results'), { recursive: true });
  writeFileSync(join(root, '-w-aida', 'aaaa-1111', 'tool-results', 'x.jsonl'), 'ignored');
  // must be ignored: workflows directory as sibling of subagents (not inside it)
  mkdirSync(join(root, '-w-aida', 'aaaa-1111', 'workflows', 'wf_abc'), { recursive: true });
  writeFileSync(join(root, '-w-aida', 'aaaa-1111', 'workflows', 'wf_abc', 'x.jsonl'), 'ignored');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('discover', () => {
  it('finds top-level sessions and subagent transcripts, ignores sidecars', async () => {
    const found = await discover(root);
    // 1 session + 2 subagents (agent-x.jsonl and deep nested agent-1.jsonl)
    expect(found).toHaveLength(3);
    const session = found.find(f => f.kind === 'session')!;
    const subs = found.filter(f => f.kind === 'subagent');
    expect(session.sessionId).toBe('aaaa-1111');
    expect(session.projectDir).toBe('-w-aida');
    expect(subs).toHaveLength(2);
    subs.forEach(sub => {
      expect(sub.sessionId).toBe('aaaa-1111');   // attributed to the PARENT (spec §6)
      expect(sub.size).toBeGreaterThan(0);
    });
  });

  it('discovers .jsonl files at any depth within subagents/', async () => {
    const found = await discover(root);
    const deepSub = found.find(f => f.path.includes('wf_abc') && f.kind === 'subagent');
    expect(deepSub).toBeDefined();
    expect(deepSub!.sessionId).toBe('aaaa-1111');
    expect(deepSub!.kind).toBe('subagent');
  });

  it('does not discover .jsonl files in sibling tool-results directory', async () => {
    const found = await discover(root);
    const fromToolResults = found.find(f => f.path.includes('tool-results'));
    expect(fromToolResults).toBeUndefined();
  });

  it('does not discover .jsonl files in sibling workflows directory', async () => {
    const found = await discover(root);
    const fromSiblingWorkflows = found.filter(f => f.path.includes('workflows'));
    // Only workflows inside subagents/ should be found, not the sibling workflows
    expect(fromSiblingWorkflows.length).toBe(1);
    expect(fromSiblingWorkflows[0]!.path).toContain('subagents');
  });

  it('returns an empty list when the root does not exist', async () => {
    expect(await discover(join(root, 'nope'))).toEqual([]);
  });
});
