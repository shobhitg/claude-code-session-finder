import { describe, it, expect } from 'vitest';
import { inScope, projectDirName } from '../src/core/scope.js';

describe('projectDirName', () => {
  it('is Claude Code\'s directory name for a path: every non-alphanumeric becomes a dash', () => {
    expect(projectDirName('/home/vscode/src/claude-code-session-finder')).toBe('-home-vscode-src-claude-code-session-finder');
    expect(projectDirName('/workspaces/aida/.claude/worktrees/x')).toBe('-workspaces-aida--claude-worktrees-x');
  });
});

describe('inScope', () => {
  const roots = ['/workspaces/aida', '/workspaces/aida/.claude/worktrees/feat', '/home/dev/parked-worktree'];
  it('a session whose cwd is in a root, or a worktree root, belongs', () => {
    expect(inScope({ cwd: '/workspaces/aida', projectDir: '-workspaces-aida' }, roots)).toBe(true);
    expect(inScope({ cwd: '/workspaces/aida/.claude/worktrees/feat/src', projectDir: '-x' }, roots)).toBe(true);
    expect(inScope({ cwd: '/home/dev/parked-worktree', projectDir: '-x' }, roots)).toBe(true);
  });
  it('a session elsewhere does not, even if its directory name looks similar', () => {
    expect(inScope({ cwd: '/home/vscode/src/other', projectDir: '-workspaces-aida' }, roots)).toBe(false);   // cwd is authoritative (F6)
    expect(inScope({ cwd: '/workspaces/aida-docs', projectDir: '-workspaces-aida-docs' }, roots)).toBe(false);  // segment-aware
  });
  it('falls back to the directory name only when there is no cwd', () => {
    expect(inScope({ cwd: null, projectDir: '-workspaces-aida' }, roots)).toBe(true);
    expect(inScope({ cwd: null, projectDir: '-workspaces-aida--claude-worktrees-other' }, roots)).toBe(true);
    expect(inScope({ cwd: null, projectDir: '-home-vscode-src-other' }, roots)).toBe(false);
  });
  it('no workspace open means everything is in scope', () => {
    expect(inScope({ cwd: '/anywhere', projectDir: '-anywhere' }, [])).toBe(true);
  });
});
