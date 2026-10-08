import { describe, it, expect } from 'vitest';
import { slackLinks, aroundLinks, worktreeOf, projectName, isDefaultBranch, sameAsBranch } from '../src/core/links.js';

describe('slackLinks', () => {
  it('finds a pasted message link and keys it by its thread', () => {
    const [s] = slackLinks('look at https://acme.slack.com/archives/C09SAARGZNE/p1759941712345678 please');
    expect(s).toEqual({ url: 'https://acme.slack.com/archives/C09SAARGZNE/p1759941712345678', thread: 'C09SAARGZNE/1759941712.345678' });
  });

  it('keys a reply link by the thread it belongs to, so a reply and its parent are one thread', () => {
    const parent = 'https://acme.slack.com/archives/C07T98X1W6S/p1759880000000100';
    const reply = 'https://acme.slack.com/archives/C07T98X1W6S/p1759881234000200?thread_ts=1759880000.000100&cid=C07T98X1W6S';
    expect(slackLinks(`${parent} and ${reply}`).map(s => s.thread)).toEqual(['C07T98X1W6S/1759880000.000100', 'C07T98X1W6S/1759880000.000100']);
    expect(slackLinks(reply)[0]!.url).toBe(reply);
  });

  it('leaves trailing punctuation and markdown brackets out of the url', () => {
    expect(slackLinks('(see https://acme.slack.com/archives/C1/p1759941712345678).')[0]!.url).toBe('https://acme.slack.com/archives/C1/p1759941712345678');
    expect(slackLinks('[thread](https://acme.slack.com/archives/C1/p1759941712345678?thread_ts=1.2,)')[0]!.url).toBe('https://acme.slack.com/archives/C1/p1759941712345678?thread_ts=1.2');
  });

  it('ignores Slack links that are not to a message', () => {
    expect(slackLinks('https://acme.slack.com/archives/C1 and https://acme.slack.com/team/U1')).toEqual([]);
  });
});

describe('aroundLinks', () => {
  it('is the prompt without its links, on one line, cut short', () => {
    expect(aroundLinks('can you look into this thread\nhttps://acme.slack.com/archives/C1/p1759941712345678  and tell me what broke'))
      .toBe('can you look into this thread … and tell me what broke');
    expect(aroundLinks('https://acme.slack.com/archives/C1/p1759941712345678')).toBe('');
    expect(aroundLinks('x'.repeat(300))).toHaveLength(120);
  });
});

describe('worktreeOf', () => {
  it('reads a Claude Code worktree from the cwd, wherever in it the session is', () => {
    expect(worktreeOf('/w/aida/.claude/worktrees/aid-9432-board-stats/python', null))
      .toEqual({ name: 'aid-9432-board-stats', path: '/w/aida/.claude/worktrees/aid-9432-board-stats' });
  });

  it('takes a .worktrees folder named after a branch with a slash as one worktree', () => {
    expect(worktreeOf('/w/aida/.worktrees/shobhit/deck-editor-spec/typescript/apps', 'shobhit/deck-editor-spec'))
      .toEqual({ name: 'deck-editor-spec', path: '/w/aida/.worktrees/shobhit/deck-editor-spec' });
  });

  it('otherwise takes the first folder under .worktrees', () => {
    expect(worktreeOf('/w/finder/.worktrees/shobhit-live-sessions-stage-1/src', 'shobhit/live-sessions-stage-1'))
      .toEqual({ name: 'shobhit-live-sessions-stage-1', path: '/w/finder/.worktrees/shobhit-live-sessions-stage-1' });
    expect(worktreeOf('/w/aida/.worktrees/shobhit/daily-promo-prompt', 'main'))
      .toEqual({ name: 'shobhit', path: '/w/aida/.worktrees/shobhit' });
  });

  it('is null for a main checkout', () => {
    expect(worktreeOf('/w/aida/python', 'main')).toBeNull();
  });
});

describe('projectName', () => {
  it('is the folder the session was started in, minus any worktree part', () => {
    expect(projectName('/workspaces/aida')).toBe('aida');
    expect(projectName('/workspaces/aida/.claude/worktrees/x/python')).toBe('aida');
    expect(projectName('/home/me/src/claude-code-session-finder/.worktrees/a/b')).toBe('claude-code-session-finder');
    expect(projectName(null)).toBeNull();
  });
});

describe('branches', () => {
  it('main, master and a detached HEAD are where work is not', () => {
    expect(['main', 'master', 'HEAD'].every(isDefaultBranch)).toBe(true);
    expect(isDefaultBranch('shobhit/x')).toBe(false);
  });

  it('a worktree named like its branch adds nothing to it', () => {
    expect(sameAsBranch('deck-editor-spec', 'shobhit/deck-editor-spec')).toBe(true);
    expect(sameAsBranch('shobhit-live-sessions-stage-1', 'shobhit/live-sessions-stage-1')).toBe(true);
    expect(sameAsBranch('chat-favicon-status', 'worktree-chat-favicon-status')).toBe(true);
    expect(sameAsBranch('aid-9432-board-stats', 'shobhit/aid-9432-deals-board-stale-pipeline')).toBe(false);
    expect(sameAsBranch('daily-promo-prompt', null)).toBe(false);
  });
});
