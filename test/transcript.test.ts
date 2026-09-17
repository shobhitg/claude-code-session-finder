import { describe, it, expect } from 'vitest';
import { parseRecords, buildTranscript, toolSummary, resultText, parseNotification, firstPrompt, RESULT_CAP } from '../src/core/transcript.js';

const T0 = Date.parse('2026-09-17T00:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const line = (o: unknown) => JSON.stringify(o);
const user = (s: number, content: unknown, extra: object = {}) => line({ type: 'user', timestamp: at(s), message: { role: 'user', content }, ...extra });
const asst = (s: number, content: unknown[], msg: object = {}) =>
  line({ type: 'assistant', timestamp: at(s), message: { id: 'msg_1', role: 'assistant', model: 'claude-sonnet-5', stop_reason: null, content, ...msg } });

describe('parseRecords', () => {
  it('skips blank and torn lines', () => {
    expect(parseRecords('{"type":"user"}\n\n{"type":"assis').map(r => r.type)).toEqual(['user']);
  });
});

describe('toolSummary', () => {
  it('names the thing each tool acts on', () => {
    expect(toolSummary('Bash', { command: 'npm test\nnpm run lint', description: 'Run the tests' })).toBe('Run the tests');
    expect(toolSummary('Bash', { command: 'npm test\nnpm run lint' })).toBe('npm test');
    expect(toolSummary('Read', { file_path: '/w/src/core/state.ts' })).toBe('state.ts');
    expect(toolSummary('Agent', { description: 'Task 1 scaffold', subagent_type: 'general-purpose' })).toBe('Task 1 scaffold');
    expect(toolSummary('Skill', { skill: 'superpowers:tdd' })).toBe('superpowers:tdd');
    expect(toolSummary('AskUserQuestion', { questions: [{ question: 'Which one?' }] })).toBe('Which one?');
    expect(toolSummary('Mystery', { count: 3, note: 'first line\nsecond' })).toBe('first line');
    expect(toolSummary('Mystery', {})).toBe('');
  });
});

describe('resultText', () => {
  it('joins text parts, counts images, caps length', () => {
    expect(resultText({ type: 'tool_result', tool_use_id: 'x', content: 'plain' })).toEqual({ text: 'plain', images: 0, truncated: 0 });
    expect(resultText({ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }))
      .toEqual({ text: 'a\nb', images: 1, truncated: 0 });
    const big = resultText({ type: 'tool_result', tool_use_id: 'x', content: 'z'.repeat(RESULT_CAP + 5) });
    expect(big.text.length).toBe(RESULT_CAP); expect(big.truncated).toBe(5);
  });
});

describe('parseNotification', () => {
  it('reads the flat tags', () => {
    const n = parseNotification('<task-notification>\n<task-id>a9c7</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n<summary>Agent "Review" finished</summary>\n<result>### Strengths\nok</result>\n</task-notification>');
    expect(n).toEqual({ taskId: 'a9c7', toolUseId: 'toolu_1', status: 'completed', summary: 'Agent "Review" finished', result: '### Strengths\nok' });
    expect(parseNotification('<task-notification></task-notification>').summary).toBe('background task update');
  });
});

describe('buildTranscript', () => {
  const recs = parseRecords([
    line({ type: 'queue-operation', operation: 'enqueue', timestamp: at(0) }),                 // hidden
    user(1, 'find the paste bug'),
    asst(2, [{ type: 'thinking', thinking: '', signature: 'x' }], { usage: { output_tokens: 10, output_tokens_details: { thinking_tokens: 4 } } }),
    asst(3, [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }],
         { usage: { output_tokens: 10, output_tokens_details: { thinking_tokens: 4 } } }),   // same message id → not double counted
    user(4, [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '149 passed' }]),
    asst(5, [{ type: 'text', text: 'All green.' }], { id: 'msg_2', stop_reason: 'end_turn', usage: { output_tokens: 7 } }),
    line({ type: 'system', subtype: 'turn_duration', durationMs: 4200, timestamp: at(5) }),
    line({ type: 'attachment', attachment: { type: 'total_tokens_reminder' }, timestamp: at(5) }),
    user(6, [{ type: 'text', text: 'and this?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]),
    asst(7, [{ type: 'tool_use', id: 'toolu_2', name: 'Agent', input: { description: 'Review it', subagent_type: 'general-purpose', run_in_background: true } }], { id: 'msg_3' }),
    user(8, [{ type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: 'Async agent launched successfully.' }] }],
         { toolUseResult: { agentId: 'a9c7', status: 'async_launched', isAsync: true } }),
    user(9, '<task-notification>\n<task-id>a9c7</task-id>\n<tool-use-id>toolu_2</tool-use-id>\n<status>completed</status>\n<summary>Agent "Review it" finished</summary>\n</task-notification>'),
    asst(10, [{ type: 'text', text: 'Done.' }], { id: 'msg_4', stop_reason: 'end_turn' }),
  ].join('\n'));
  const t = buildTranscript(recs);

  it('splits turns on prompts and notifications, counting hidden housekeeping', () => {
    expect(t.turns.map(x => [x.promptKind, x.prompt])).toEqual([
      ['user', 'find the paste bug'], ['user', 'and this?'], ['notification', 'Agent "Review it" finished'],
    ]);
    expect(t.records).toBe(13); expect(t.hidden).toBe(3);      // queue-operation, system, attachment
    expect(t.model).toBe('claude-sonnet-5');
    expect(t.firstTs).toBe(T0); expect(t.lastTs).toBe(T0 + 10_000);
  });

  it('pairs tool results with their calls and keeps the turn timeline', () => {
    const first = t.turns[0]!;
    expect(first.items.map(i => i.kind)).toEqual(['thinking', 'tool', 'text']);
    const tool = first.items[1]!; if (tool.kind !== 'tool') throw new Error('expected tool');
    expect(tool.call).toMatchObject({ name: 'Bash', summary: 'Run tests', ts: T0 + 3000, result: { text: '149 passed', isError: false, ts: T0 + 4000 } });
    expect(first.durationMs).toBe(4200);
    expect(first.startTs).toBe(T0 + 1000); expect(first.endTs).toBe(T0 + 5000);
  });

  it('counts tokens once per message id and records the model', () => {
    const first = t.turns[0]!;
    expect(first.outputTokens).toBe(17);      // msg_1 (10, once) + msg_2 (7)
    expect(first.thinkingTokens).toBe(4);
    expect(first.model).toBe('claude-sonnet-5');
  });

  it('inlines prompt images and links spawns to their agent id', () => {
    const second = t.turns[1]!;
    expect(second.promptImages).toBe(1);
    expect(second.items[0]).toMatchObject({ kind: 'image', mediaType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' });
    const spawn = second.items.find(i => i.kind === 'tool'); if (!spawn || spawn.kind !== 'tool') throw new Error('expected spawn');
    expect(spawn.call.agentId).toBe('a9c7');
    expect(spawn.call.result?.text).toContain('Async agent launched');
  });

  it('a tool result with no prior call, and results before any prompt, do not throw', () => {
    const odd = buildTranscript(parseRecords([user(1, [{ type: 'tool_result', tool_use_id: 'nope', content: 'x' }])].join('\n')));
    expect(odd.turns).toHaveLength(1); expect(odd.turns[0]!.promptKind).toBe('meta');
  });
});

describe('firstPrompt', () => {
  it('is the first human line, never a notification or meta record', () => {
    const recs = parseRecords([
      user(1, '<task-notification><summary>x</summary></task-notification>'),
      user(2, 'system reminder', { isMeta: true }),
      user(3, [{ type: 'text', text: 'Investigate the flaky test\nmore' }]),
    ].join('\n'));
    expect(firstPrompt(recs)).toBe('Investigate the flaky test');
    expect(firstPrompt([])).toBeUndefined();
  });
  it('skips blank lines and markdown headings', () => {
    expect(firstPrompt(parseRecords(user(1, "\n# Question\nAida's forecast for the deal was stale\nWHY?")))).toBe("Aida's forecast for the deal was stale");
  });
});

describe('injected context (isMeta user records)', () => {
  it('attaches to the current turn as a context item instead of starting a new turn', () => {
    const t = buildTranscript(parseRecords([
      user(1, 'run the skill'),
      asst(2, [{ type: 'tool_use', id: 'toolu_s', name: 'Skill', input: { skill: 'superpowers:tdd' } }]),
      user(3, [{ type: 'tool_result', tool_use_id: 'toolu_s', content: 'Launching skill' }]),
      user(3, 'Base directory for this skill: /x\n\n# TDD\n…', { isMeta: true }),
      user(4, [{ type: 'text', text: '<system-reminder>be brief</system-reminder>' }], { isMeta: true }),
      asst(5, [{ type: 'text', text: 'Red, green, refactor.' }], { id: 'msg_9', stop_reason: 'end_turn' }),
    ].join('\n')));
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]!.items.map(i => i.kind)).toEqual(['tool', 'context', 'context', 'text']);
    expect(t.turns[0]!.items[1]).toMatchObject({ kind: 'context', text: expect.stringContaining('# TDD') });
    expect(t.turns[0]!.endTs).toBe(T0 + 5000);
  });
  it('a meta record before any prompt still gets an implicit turn', () => {
    const t = buildTranscript(parseRecords([user(1, 'context first', { isMeta: true }), user(2, 'now a prompt')].join('\n')));
    expect(t.turns.map(x => [x.promptKind, x.items.length])).toEqual([['meta', 1], ['user', 0]]);
  });
});
