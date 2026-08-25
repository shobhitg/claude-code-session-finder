import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractSession, extractSubagent } from '../src/core/extract.js';
import type { SourceFile } from '../src/core/discover.js';

const f = (kind: SourceFile['kind'] = 'session'): SourceFile => ({
  path: '/p/-w-a/s1.jsonl', sessionId: 's1', projectDir: '-w-a', kind, mtimeMs: 5, size: 9,
});

const line = (o: unknown) => JSON.stringify(o);

describe('extractSession', () => {
  it('pulls prose and skips images, tool results and thinking', () => {
    const text = [
      line({ type: 'user', cwd: '/a', timestamp: '2026-08-01T00:00:00Z',
             message: { content: 'find the paste bug' } }),
      line({ type: 'user', timestamp: '2026-08-01T00:00:01Z',
             message: { content: [{ type: 'tool_result', content: 'SECRET STDOUT' }] } }),
      line({ type: 'assistant', timestamp: '2026-08-01T00:00:02Z',
             message: { content: [
               { type: 'thinking', thinking: 'SECRET THOUGHT' },
               { type: 'tool_use', name: 'Bash', input: { command: 'SECRET CMD' } },
               { type: 'text', text: 'here is the fix' }] } }),
      line({ type: 'user', timestamp: '2026-08-01T00:00:03Z',
             message: { content: [{ type: 'image', source: { data: 'SECRETB64' } }] } }),
    ].join('\n');

    const { prose } = extractSession(f(), text);
    const all = prose.map(p => p.x).join(' | ');
    expect(all).toContain('find the paste bug');
    expect(all).toContain('here is the fix');
    expect(all).not.toContain('SECRET');
    expect(prose.map(p => p.r)).toEqual(['u', 'a']);
  });

  it('takes the LAST cwd, not the first, and not the directory name (F6)', () => {
    const text = [
      line({ type: 'user', cwd: '/first', timestamp: '2026-08-01T00:00:00Z', message: { content: 'a' } }),
      line({ type: 'user', cwd: '/second', timestamp: '2026-08-01T00:00:01Z', message: { content: 'b' } }),
    ].join('\n');
    expect(extractSession(f(), text).meta.cwd).toBe('/second');
  });

  it('captures title, pr links, branches and real timestamps', () => {
    const text = [
      line({ type: 'user', gitBranch: 'main', timestamp: '2026-08-01T00:00:00Z', message: { content: 'a' } }),
      line({ type: 'pr-link', prNumber: 1234, timestamp: '2026-08-01T00:00:01Z' }),
      line({ type: 'user', gitBranch: 'feat/x', timestamp: '2026-08-02T00:00:00Z', message: { content: 'b' } }),
      line({ type: 'ai-title', aiTitle: 'Paste-image handling in the composer' }),
    ].join('\n');
    const { meta, prose } = extractSession(f(), text);
    expect(meta.title).toBe('Paste-image handling in the composer');
    expect(meta.prLinks).toEqual([1234]);
    expect(meta.branches.sort()).toEqual(['feat/x', 'main']);
    expect(meta.firstTs).toBe(Date.parse('2026-08-01T00:00:00Z'));
    expect(meta.lastTs).toBe(Date.parse('2026-08-02T00:00:00Z'));
    expect(prose.some(p => p.r === 't' && p.x.includes('Paste-image handling'))).toBe(true);
  });

  it('marks sidechain turns as subagent prose', () => {
    const text = line({ type: 'user', isSidechain: true, timestamp: '2026-08-01T00:00:00Z',
                        message: { content: 'delegated work' } });
    expect(extractSession(f(), text).prose[0]!.r).toBe('sub');
  });

  it('survives a truncated final line', () => {
    const text = line({ type: 'user', timestamp: '2026-08-01T00:00:00Z', message: { content: 'a' } })
      + '\n{"type":"user","mess';
    expect(() => extractSession(f(), text)).not.toThrow();
    expect(extractSession(f(), text).prose).toHaveLength(1);
  });
});

describe('extractSubagent', () => {
  it('returns prose tagged sub', () => {
    const text = line({ type: 'assistant', timestamp: '2026-08-01T00:00:00Z',
                        message: { content: [{ type: 'text', text: 'agent report' }] } });
    const prose = extractSubagent(f('subagent'), text);
    expect(prose).toHaveLength(1);
    expect(prose[0]!.r).toBe('sub');
    expect(prose[0]!.x).toBe('agent report');
  });
});

describe('extract against redacted real fixtures', () => {
  it('resolves cwd from content even when the directory name disagrees (F6)', () => {
    const path = join(__dirname, 'fixtures', 'moved-cwd.jsonl');
    const src: SourceFile = { path, sessionId: 'fixture', kind: 'session',
      projectDir: '-dir-proj--claude-wt-feature-branch', mtimeMs: 1, size: 1 };
    const { meta } = extractSession(src, readFileSync(path, 'utf8'));
    expect(meta.cwd).toBeTruthy();
    // the whole point: the resolved cwd is NOT reconstructible from projectDir
    expect(meta.cwd).not.toBe(src.projectDir);
    expect(meta.cwd!.startsWith('/')).toBe(true);
  });
});
