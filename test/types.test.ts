import { describe, it, expect } from 'vitest';
import { INDEX_VERSION } from '../src/core/types.js';
import type { SessionMeta, ProseMsg, SearchIndex } from '../src/core/types.js';

describe('types', () => {
  it('exports a numeric index version', () => {
    expect(typeof INDEX_VERSION).toBe('number');
    expect(INDEX_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('a SearchIndex is structurally assignable', () => {
    const meta: SessionMeta = {
      sessionId: 'a', file: '/a.jsonl', projectDir: '-a',
      cwd: '/a', cwdExists: true, title: null, branches: [], prLinks: [],
      firstTs: 1, lastTs: 2, msgCount: 0, mtimeMs: 1, size: 1,
    };
    const prose: ProseMsg = { s: 0, r: 'u', t: 1, x: 'hello' };
    const idx: SearchIndex = { v: INDEX_VERSION, builtAt: 0, sessions: [meta], prose: [prose] };
    expect(idx.sessions[0].sessionId).toBe('a');
  });
});
