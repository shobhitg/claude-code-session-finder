import { describe, it, expect } from 'vitest';
import { planOpen } from '../src/core/resolve.js';
import type { SessionMeta } from '../src/core/types.js';

const s = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  sessionId: 'sid', file: '/p/sid.jsonl', projectDir: '-w-a', cwd: '/w/a', cwdExists: true,
  title: null, branches: [], prLinks: [], firstTs: 0, lastTs: 0, msgCount: 0, mtimeMs: 0, size: 0, ...over,
});

describe('planOpen', () => {
  it('opens here when cwd is the primary folder', () => {
    expect(planOpen(s(), ['/w/a'])).toEqual({ kind: 'here', sessionId: 'sid' });
  });

  it('opens here when cwd is inside any workspace folder (multi-root, F5)', () => {
    const plan = planOpen(s({ cwd: '/w/b/python' }), ['/w/a', '/w/b']);
    expect(plan.kind).toBe('here');
    expect((plan as { note?: string }).note).toMatch(/workspace root/i);
  });

  it('hands off when cwd is outside the workspace', () => {
    expect(planOpen(s({ cwd: '/w/other' }), ['/w/a']))
      .toEqual({ kind: 'handoff', sessionId: 'sid', targetCwd: '/w/other' });
  });

  it('falls back to the transcript when the folder is gone', () => {
    const plan = planOpen(s({ cwd: '/w/gone', cwdExists: false }), ['/w/a']);
    expect(plan).toEqual({ kind: 'transcript', file: '/p/sid.jsonl', reason: 'folder missing' });
  });

  it('opens here with a note when no cwd was ever recorded', () => {
    const plan = planOpen(s({ cwd: null }), ['/w/a']);
    expect(plan.kind).toBe('here');
    expect((plan as { note?: string }).note).toMatch(/unknown folder/i);
  });

  it('does not treat /w/ab as inside /w/a', () => {
    expect(planOpen(s({ cwd: '/w/ab' }), ['/w/a']).kind).toBe('handoff');
  });

  it('opens here when there is no workspace open at all', () => {
    expect(planOpen(s(), []).kind).toBe('handoff');
  });
});
