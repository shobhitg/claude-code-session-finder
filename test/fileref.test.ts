import { describe, it, expect } from 'vitest';
import { candidates, normalize, worktreeOf, fileKind } from '../src/core/fileref.js';

describe('fileref (D20)', () => {
  it('normalize resolves . and .. and never climbs above the root', () => {
    expect(normalize('/a/./b/../c//d')).toBe('/a/c/d');
    expect(normalize('/../x')).toBe('/x');
    expect(normalize('a/b/../c')).toBe('a/c');
  });
  it('names the worktree a folder sits in, including a two-segment name', () => {
    expect(worktreeOf('/w/aida/.worktrees/shobhit/selection-ask/typescript')).toBe('shobhit/selection-ask');
    expect(worktreeOf('/w/repo/.claude/worktrees/fix-x')).toBe('fix-x');
    expect(worktreeOf('/w/repo/src')).toBeUndefined();
  });
  it('an absolute path is itself first; inside a worktree, the main checkout\'s copy follows for every way to split the worktree name', () => {
    const c = candidates('/w/aida/.worktrees/shobhit/sel/typescript/a.ts', {});
    expect(c.map(x => [x.path, x.via])).toEqual([
      ['/w/aida/.worktrees/shobhit/sel/typescript/a.ts', 'absolute'],
      ['/w/aida/sel/typescript/a.ts', 'main-checkout'],
      ['/w/aida/typescript/a.ts', 'main-checkout'],
      ['/w/aida/a.ts', 'main-checkout'],
    ]);
    expect(c[2]!.why).toMatch(/worktree shobhit\/sel is gone/);
  });
  it('a relative path tries the folder it was working in, its parents, the gone worktree\'s main checkout, then the session folder', () => {
    const c = candidates('src/a.ts', { cwd: '/w/repo/.worktrees/feat/api', sessionCwd: '/w/repo' });
    expect(c.map(x => x.path)).toEqual([
      '/w/repo/.worktrees/feat/api/src/a.ts', '/w/repo/.worktrees/feat/src/a.ts', '/w/repo/.worktrees/src/a.ts', '/w/repo/src/a.ts', '/w/src/a.ts',
    ]);
    expect(c[0]!.why).toMatch(/worktree feat\/api, where it was working/);
    expect(c.find(x => x.path === '/w/repo/src/a.ts')!.via).toBe('ancestor');         // first reached as a parent; listed once
  });
  it('expands ~/ and strips ./', () => {
    expect(candidates('~/notes/x.md', { home: '/home/me' })[0]!.path).toBe('/home/me/notes/x.md');
    expect(candidates('./a.ts', { cwd: '/w' })[0]!.path).toBe('/w/a.ts');
  });
  it('fileKind labels a file and knows which ones preview as images', () => {
    expect(fileKind('/a/b.png')).toEqual({ label: 'PNG image', image: 'image/png' });
    expect(fileKind('x.ts')).toEqual({ label: 'TypeScript' });
    expect(fileKind('Makefile')).toEqual({ label: 'File' });
  });
});
