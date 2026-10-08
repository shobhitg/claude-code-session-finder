import { describe, it, expect } from 'vitest';
import { lastAct, type ActRec } from '../src/core/acts.js';

const at = (s: number): string => new Date(s * 1000).toISOString();
const T = (s: number): number => s * 1000;
const prompt = (s: number, extra: Partial<ActRec> = {}): ActRec => ({ type: 'user', timestamp: at(s), message: { content: 'fix the bug' }, ...extra });
const reply = (s: number): ActRec => ({ type: 'assistant', timestamp: at(s), message: { content: [{ type: 'text', text: 'done' }] } });
const ask = (s: number, id: string, name = 'AskUserQuestion'): ActRec =>
  ({ type: 'assistant', timestamp: at(s), message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
const result = (s: number, id: string, extra: Partial<ActRec> = {}): ActRec =>
  ({ type: 'user', timestamp: at(s), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, ...extra });
const text = (s: number, t: string, extra: Partial<ActRec> = {}): ActRec => ({ type: 'user', timestamp: at(s), message: { content: [{ type: 'text', text: t }] }, ...extra });

describe('lastAct: when you last did something to a session', () => {
  it('is your newest prompt; Claude replying, calling tools and finishing are not you', () => {
    expect(lastAct([prompt(1), reply(2), prompt(3), reply(4), ask(5, 'bash', 'Bash'), result(6, 'bash'), reply(7)])).toBe(T(3));
  });

  it('is undefined when nothing in the records was you', () => {
    expect(lastAct([reply(1), { type: 'last-prompt', timestamp: at(2) }, { type: 'mode' }])).toBeUndefined();
    expect(lastAct([])).toBeUndefined();
  });

  it('an answer to a question or a plan is you; any other tool result is not', () => {
    expect(lastAct([prompt(1), ask(2, 'q1'), result(3, 'q1')])).toBe(T(3));
    expect(lastAct([prompt(1), ask(2, 'p1', 'ExitPlanMode'), result(3, 'p1')])).toBe(T(3));
    expect(lastAct([prompt(1), ask(2, 'e1', 'Edit'), result(3, 'e1')])).toBe(T(1));
    expect(lastAct([prompt(1), result(3, 'q-before-the-window')])).toBe(T(1));   // its question is not in the records read
    expect(lastAct([prompt(1), ask(2, 'q1'), result(3, 'q1', { toolDenialUnanswered: true })])).toBe(T(1));
  });

  it('Esc and slash commands are you; the CLI\'s echo of a command is not', () => {
    expect(lastAct([prompt(1), text(2, '[Request interrupted by user]')])).toBe(T(2));
    expect(lastAct([prompt(1), text(2, '[Request interrupted by user for tool use]')])).toBe(T(2));
    expect(lastAct([prompt(1), prompt(2, { message: { content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>' } }),
                    prompt(3, { message: { content: '<local-command-stdout>Compacted</local-command-stdout>' } }),
                    prompt(4, { message: { content: '<local-command-caveat>Caveat: …</local-command-caveat>' } })])).toBe(T(2));
  });

  it('a prompt that only mentions a notification tag is still yours; a notification starts with it', () => {
    expect(lastAct([prompt(1), prompt(2, { message: { content: 'why does the <task-notification> block show twice?' } })])).toBe(T(2));
  });

  it('a pasted image with no text is a prompt', () => {
    expect(lastAct([prompt(1), { type: 'user', timestamp: at(2), message: { content: [{ type: 'image', source: {} }] } }])).toBe(T(2));
  });

  it('what Claude Code writes on its own is not you: compaction, a shutdown, injected context, notifications, subagents', () => {
    expect(lastAct([
      prompt(1),
      prompt(2, { isCompactSummary: true, turnOrigin: 'human', message: { content: 'This session is being continued from a previous conversation…' } }),
      text(3, '[Request interrupted by user for tool use]', { interruptedByShutdown: true }),
      prompt(4, { isMeta: true, message: { content: 'Base directory for this skill: …' } }),
      prompt(5, { message: { content: '<task-notification>\n<status>completed</status>\n</task-notification>' } }),
      prompt(6, { isSidechain: true }),
    ])).toBe(T(1));
  });

  it('trusts the record when it says who wrote it (origin, else turnOrigin)', () => {
    expect(lastAct([prompt(1, { origin: { kind: 'human' } }), prompt(2, { origin: { kind: 'task-notification' } }), prompt(3, { origin: { kind: 'peer' } })])).toBe(T(1));
    expect(lastAct([prompt(1, { turnOrigin: 'human' }), prompt(2, { turnOrigin: 'sdk', message: { content: 'Make one promo video. RUN_ID=…' } })])).toBe(T(1));
  });

  it('a prompt queued while Claude works is you; a queued notification is not', () => {
    const queued = (s: number, attachment: ActRec['attachment']): ActRec => ({ type: 'attachment', timestamp: at(s), attachment });
    expect(lastAct([prompt(1), queued(2, { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' } })])).toBe(T(2));
    expect(lastAct([prompt(1), queued(2, { type: 'queued_command', commandMode: 'prompt' })])).toBe(T(2));
    expect(lastAct([prompt(1), queued(2, { type: 'queued_command', commandMode: 'task-notification', origin: { kind: 'task-notification' } })])).toBe(T(1));
    expect(lastAct([prompt(1), queued(2, { type: 'queued_command', commandMode: 'task-notification' })])).toBe(T(1));
    expect(lastAct([prompt(1), queued(2, { type: 'hook_success' })])).toBe(T(1));
  });

  it('skips a record whose timestamp it cannot read', () => {
    expect(lastAct([prompt(1), { type: 'user', message: { content: 'no clock' } }, { type: 'user', timestamp: 'garbage', message: { content: 'x' } }])).toBe(T(1));
  });
});
