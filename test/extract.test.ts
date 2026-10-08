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

  it('captures title, pr links, branch and real timestamps', () => {
    const text = [
      line({ type: 'user', gitBranch: 'main', timestamp: '2026-08-01T00:00:00Z', message: { content: 'a' } }),
      line({ type: 'pr-link', prNumber: 1234, timestamp: '2026-08-01T00:00:01Z' }),
      line({ type: 'user', gitBranch: 'feat/x', timestamp: '2026-08-02T00:00:00Z', message: { content: 'b' } }),
      line({ type: 'ai-title', aiTitle: 'Paste-image handling in the composer' }),
    ].join('\n');
    const { meta, prose } = extractSession(f(), text);
    expect(meta.title).toBe('Paste-image handling in the composer');
    expect(meta.prs.map(p => p.n)).toEqual([1234]);
    expect(meta.branch).toBe('feat/x');
    expect(meta.firstTs).toBe(Date.parse('2026-08-01T00:00:00Z'));
    expect(meta.lastTs).toBe(Date.parse('2026-08-02T00:00:00Z'));
    expect(prose.some(p => p.r === 't' && p.x.includes('Paste-image handling'))).toBe(true);
  });

  it('the branch is the last one worked on — not main or a detached HEAD it went back to — and branchNow is where it is', () => {
    const text = [
      line({ type: 'user', gitBranch: 'main', timestamp: '2026-08-01T00:00:00Z', message: { content: 'a' } }),
      line({ type: 'assistant', gitBranch: 'shobhit/promo-run-timeout', timestamp: '2026-08-01T00:01:00Z', message: { content: [{ type: 'text', text: 'b' }] } }),
      line({ type: 'user', gitBranch: 'main', timestamp: '2026-08-01T00:02:00Z', message: { content: 'c' } }),
    ].join('\n');
    const { meta } = extractSession(f(), text);
    expect(meta.branch).toBe('shobhit/promo-run-timeout');
    expect(meta.branchNow).toBe('main');
    const never = extractSession(f(), line({ type: 'user', gitBranch: 'HEAD', timestamp: '2026-08-01T00:00:00Z', message: { content: 'a' } })).meta;
    expect([never.branch, never.branchNow]).toEqual(['HEAD', 'HEAD']);
    expect(extractSession(f(), line({ type: 'user', message: { content: 'a' } })).meta.branch).toBeNull();
  });

  it('records where the session started, for its project name', () => {
    const text = [
      line({ type: 'user', cwd: '/w/aida', timestamp: '2026-08-01T00:00:00Z', message: { content: 'a' } }),
      line({ type: 'user', cwd: '/w/aida/.claude/worktrees/x', timestamp: '2026-08-01T00:00:01Z', message: { content: 'b' } }),
    ].join('\n');
    expect(extractSession(f(), text).meta.launchCwd).toBe('/w/aida');
  });

  it('knows the worktree its last cwd is in, by the name Claude Code gave it', () => {
    const text = [
      line({ type: 'user', cwd: '/w/aida', gitBranch: 'main', timestamp: '2026-08-01T00:00:00Z', message: { content: 'a' } }),
      line({ type: 'worktree-state', worktreeSession: { worktreePath: '/w/aida/.claude/worktrees/pr20165-fixes', worktreeName: 'pr20165-fixes', worktreeBranch: 'jatina/seq' } }),
      line({ type: 'user', cwd: '/w/aida/.claude/worktrees/pr20165-fixes/web', gitBranch: 'jatina/seq', timestamp: '2026-08-01T00:00:01Z', message: { content: 'b' } }),
    ].join('\n');
    expect(extractSession(f(), text).meta.worktree).toEqual({ name: 'pr20165-fixes', path: '/w/aida/.claude/worktrees/pr20165-fixes' });
    const back = text + '\n' + line({ type: 'user', cwd: '/w/aida', gitBranch: 'main', timestamp: '2026-08-01T00:00:02Z', message: { content: 'c' } });
    expect(extractSession(f(), back).meta.worktree).toBeNull();
  });

  it('reads a .worktrees worktree as deep as the branch checked out in it, despite a stray main', () => {
    const text = [
      line({ type: 'user', cwd: '/w/aida/.worktrees/shobhit/deck-editor-spec', gitBranch: 'shobhit/deck-editor-spec', timestamp: '2026-08-01T00:00:00Z', message: { content: 'a' } }),
      line({ type: 'user', cwd: '/w/aida/.worktrees/shobhit/deck-editor-spec/typescript', gitBranch: 'main', timestamp: '2026-08-01T00:00:01Z', message: { content: 'b' } }),
    ].join('\n');
    expect(extractSession(f(), text).meta.worktree).toEqual({ name: 'deck-editor-spec', path: '/w/aida/.worktrees/shobhit/deck-editor-spec' });
  });

  it('lists each linked PR once, with its repo, url, when it was first linked and the branch worked on then', () => {
    const pr = (n: number, ts: string) => line({ type: 'pr-link', prNumber: n, prRepository: 'acme/app', prUrl: `https://github.com/acme/app/pull/${n}`, timestamp: ts });
    const text = [
      pr(1, '2026-08-01T00:00:00Z'),
      line({ type: 'user', gitBranch: 'shobhit/x', timestamp: '2026-08-01T00:01:00Z', message: { content: 'a' } }),
      pr(2, '2026-08-01T00:02:00Z'), pr(1, '2026-08-01T00:03:00Z'), pr(2, '2026-08-01T00:04:00Z'),
    ].join('\n');
    expect(extractSession(f(), text).meta.prs).toEqual([
      { n: 1, repo: 'acme/app', url: 'https://github.com/acme/app/pull/1', ts: Date.parse('2026-08-01T00:00:00Z'), branch: null },
      { n: 2, repo: 'acme/app', url: 'https://github.com/acme/app/pull/2', ts: Date.parse('2026-08-01T00:02:00Z'), branch: 'shobhit/x' },
    ]);
  });

  it('lists the Slack threads you pasted, once per thread — not ones Claude or a subagent wrote, nor tool output', () => {
    const link = 'https://acme.slack.com/archives/C1/p1759941712345678';
    const reply = 'https://acme.slack.com/archives/C1/p1759941799000000?thread_ts=1759941712.345678';
    const text = [
      line({ type: 'user', timestamp: '2026-08-01T00:00:00Z', message: { content: `why is this failing? ${link}` } }),
      line({ type: 'user', timestamp: '2026-08-01T00:01:00Z', message: { content: `same thread: ${reply}` } }),
      line({ type: 'assistant', timestamp: '2026-08-01T00:02:00Z', message: { content: [{ type: 'text', text: 'https://acme.slack.com/archives/C2/p1759941700000000' }] } }),
      line({ type: 'user', isSidechain: true, timestamp: '2026-08-01T00:03:00Z', message: { content: 'https://acme.slack.com/archives/C3/p1759941700000000' } }),
      line({ type: 'user', timestamp: '2026-08-01T00:04:00Z', message: { content: [{ type: 'tool_result', content: 'https://acme.slack.com/archives/C4/p1759941700000000' }] } }),
    ].join('\n');
    expect(extractSession(f(), text).meta.slack).toEqual([
      { url: link, thread: 'C1/1759941712.345678', ts: Date.parse('2026-08-01T00:00:00Z'), said: 'why is this failing?' },
    ]);
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

describe('titles (spec L12)', () => {
  it('a custom-title beats every ai-title, and the latest custom-title wins', () => {
    const text = [
      line({ type: 'custom-title', customTitle: 'My name', timestamp: '2026-08-01T00:00:00Z' }),
      line({ type: 'ai-title', aiTitle: 'Auto name', timestamp: '2026-08-01T00:00:01Z' }),
      line({ type: 'custom-title', customTitle: 'My better name', timestamp: '2026-08-01T00:00:02Z' }),
    ].join('\n');
    const { meta, prose } = extractSession(f(), text);
    expect(meta.title).toBe('My better name');
    expect(prose.filter(p => p.r === 't').map(p => p.x)).toEqual(['My name', 'Auto name', 'My better name']);
  });
  it('records when you last acted (D14): your prompt, not Claude\'s reply or a notification after it; 0 if never', () => {
    const text = [
      line({ type: 'user', timestamp: '2026-08-01T00:00:00Z', message: { content: 'first ask' } }),
      line({ type: 'user', timestamp: '2026-08-01T01:00:00Z', message: { content: 'second ask' }, origin: { kind: 'human' } }),
      line({ type: 'assistant', timestamp: '2026-08-01T02:00:00Z', message: { content: [{ type: 'text', text: 'done' }] } }),
      line({ type: 'user', timestamp: '2026-08-01T03:00:00Z', message: { content: '<task-notification>…</task-notification>' }, origin: { kind: 'task-notification' } }),
    ].join('\n');
    expect(extractSession(f(), text).meta).toMatchObject({ lastActTs: Date.parse('2026-08-01T01:00:00Z'), lastTs: Date.parse('2026-08-01T03:00:00Z') });
    const scripted = line({ type: 'user', timestamp: '2026-08-01T00:00:00Z', message: { content: 'Make one promo video' }, turnOrigin: 'sdk' });
    expect(extractSession(f(), scripted).meta.lastActTs).toBe(0);
  });
  it('falls back to the latest ai-title when there is no custom-title', () => {
    const text = [line({ type: 'ai-title', aiTitle: 'First' }), line({ type: 'ai-title', aiTitle: 'Second' })].join('\n');
    expect(extractSession(f(), text).meta.title).toBe('Second');
  });
});

describe('headless (D15)', () => {
  const rec = (o: object) => line({ type: 'user', timestamp: '2026-08-01T00:00:00Z', message: { content: 'go' }, ...o });

  it('a session started by claude -p (an SDK entrypoint) is headless; an interactive one is not', () => {
    for (const ep of ['sdk-cli', 'sdk-ts', 'sdk-py']) expect(extractSession(f(), rec({ entrypoint: ep })).meta.headless).toBe(true);
    for (const ep of ['cli', 'claude-vscode']) expect(extractSession(f(), rec({ entrypoint: ep })).meta.headless).toBe(false);
    expect(extractSession(f(), rec({})).meta.headless).toBe(false);
  });

  it('the first entrypoint decides — a -p run resumed in VS Code stays headless, as Claude Code itself counts it', () => {
    const resumed = [line({ type: 'queue-operation', operation: 'enqueue' }), rec({ entrypoint: 'sdk-cli' }), rec({ entrypoint: 'claude-vscode' })].join('\n');
    expect(extractSession(f(), resumed).meta.headless).toBe(true);
    const interactive = [rec({ entrypoint: 'claude-vscode' }), rec({ entrypoint: 'sdk-cli' })].join('\n');
    expect(extractSession(f(), interactive).meta.headless).toBe(false);
  });

  it('a daemon session is headless; a background (bg) one, which you can attach to, is not', () => {
    expect(extractSession(f(), rec({ entrypoint: 'cli', sessionKind: 'daemon' })).meta.headless).toBe(true);
    expect(extractSession(f(), rec({ entrypoint: 'cli', sessionKind: 'daemon-worker' })).meta.headless).toBe(true);
    expect(extractSession(f(), rec({ entrypoint: 'cli', sessionKind: 'bg' })).meta.headless).toBe(false);
  });
});
