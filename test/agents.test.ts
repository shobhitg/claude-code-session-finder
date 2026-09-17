import { describe, it, expect } from 'vitest';
import { buildGraph, bars, type AgentFile } from '../src/core/agents.js';
import { parseRecords } from '../src/core/transcript.js';

const T0 = Date.parse('2026-09-17T00:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const line = (o: unknown) => JSON.stringify(o);
const user = (s: number, content: unknown, extra: object = {}) => line({ type: 'user', timestamp: at(s), message: { role: 'user', content }, ...extra });
const asst = (s: number, content: unknown[], stop: string | null = 'tool_use') =>
  line({ type: 'assistant', timestamp: at(s), message: { id: `m${s}`, role: 'assistant', model: 'claude-sonnet-5', stop_reason: stop, content } });
const spawn = (s: number, id: string, description: string, extra: object = {}) =>
  asst(s, [{ type: 'tool_use', id, name: 'Agent', input: { description, subagent_type: 'general-purpose', prompt: 'do it', ...extra } }]);
const result = (s: number, id: string, tur: object | undefined, content: unknown = 'ok', is_error?: boolean) =>
  user(s, [{ type: 'tool_result', tool_use_id: id, content, ...(is_error ? { is_error: true } : {}) }], tur ? { toolUseResult: tur } : {});
const notif = (s: number, taskId: string, toolUseId: string, status = 'completed') =>
  user(s, `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>done</summary>\n</task-notification>`);
const agentFile = (agentId: string, recs: string[], mtimeS: number, runId?: string): AgentFile =>
  ({ path: `/p/s/subagents/${runId ? `workflows/${runId}/` : ''}agent-${agentId}.jsonl`, agentId, recs: parseRecords(recs.join('\n')), mtimeMs: T0 + mtimeS * 1000, ...(runId ? { runId } : {}) });
const NOW = T0 + 600_000;
const base = (mainRecs: string[], agents: AgentFile[] = [], journals = {}, now = NOW) =>
  buildGraph({ title: 'My session', mainFile: '/p/s.jsonl', mainRecs: parseRecords(mainRecs.join('\n')), mainMtimeMs: T0 + 20_000, agents, journals, now });

describe('buildGraph — session root', () => {
  it('is completed when the main loop ended its turn, running when fresh and in flight', () => {
    const done = base([user(1, 'hi'), asst(2, [{ type: 'text', text: 'ok' }], 'end_turn')]);
    expect(done.nodes.session).toMatchObject({ kind: 'session', label: 'My session', status: 'completed', model: 'claude-sonnet-5', endTs: T0 + 2000, file: '/p/s.jsonl' });
    const live = buildGraph({ title: 't', mainFile: '/p/s.jsonl', mainRecs: parseRecords([user(1, 'hi'), asst(2, [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }])].join('\n')),
                              mainMtimeMs: NOW - 5_000, agents: [], journals: {}, now: NOW });
    expect(live.nodes.session!.status).toBe('running');
  });
});

describe('buildGraph — spawns', () => {
  it('a foreground agent: completed, with tokens, duration, model and its file', () => {
    const g = base(
      [user(1, 'go'), spawn(2, 'toolu_1', 'Task 1 scaffold'),
       result(150, 'toolu_1', { agentId: 'aaa1', agentType: 'general-purpose', status: 'completed', resolvedModel: 'claude-sonnet-5', totalDurationMs: 144_440, totalTokens: 64_607, totalToolUseCount: 22 })],
      [agentFile('aaa1', [user(3, 'do it'), asst(100, [{ type: 'text', text: 'done' }], 'end_turn')], 150)]);
    const n = g.nodes['spawn:toolu_1']!;
    expect(n).toMatchObject({ kind: 'agent', label: 'Task 1 scaffold', status: 'completed', background: false, agentId: 'aaa1',
                              spawnTs: T0 + 2000, endTs: T0 + 150_000, totalTokens: 64_607, toolUses: 22, durationMs: 144_440,
                              model: 'claude-sonnet-5', subagentType: 'general-purpose', parentId: 'session', file: '/p/s/subagents/agent-aaa1.jsonl' });
    expect(g.nodes.session!.children).toEqual(['spawn:toolu_1']);
    expect(g.order).toEqual(['session', 'spawn:toolu_1']);
  });

  it('a background agent: launched, then finished by its task-notification', () => {
    const g = base([user(1, 'go'), spawn(2, 'toolu_2', 'Review', { run_in_background: true }),
                    result(3, 'toolu_2', { agentId: 'bbb2', status: 'async_launched', isAsync: true }, [{ type: 'text', text: 'Async agent launched successfully.' }]),
                    notif(90, 'bbb2', 'toolu_2')],
                   [agentFile('bbb2', [user(4, 'review'), asst(80, [{ type: 'text', text: 'ok' }], 'end_turn')], 80)]);
    expect(g.nodes['spawn:toolu_2']).toMatchObject({ background: true, status: 'completed', launchedTs: T0 + 3000, endTs: T0 + 90_000, agentId: 'bbb2' });
  });

  it('a background agent with no notification yet is launched (fresh) or stopped (stale)', () => {
    const fresh = base([user(1, 'go'), spawn(2, 'toolu_3', 'Slow', { run_in_background: true }), result(3, 'toolu_3', { agentId: 'ccc3', status: 'async_launched' })],
                       [agentFile('ccc3', [user(4, 'x'), asst(5, [{ type: 'tool_use', id: 'q', name: 'Bash', input: {} }])], 599)]);
    expect(fresh.nodes['spawn:toolu_3']!.status).toBe('running');
    // quiet for 33 minutes — past the 15-minute stall threshold (state.ts DEFAULT_THRESHOLDS)
    const stale = base([user(1, 'go'), spawn(2, 'toolu_3', 'Slow', { run_in_background: true }), result(3, 'toolu_3', { agentId: 'ccc3', status: 'async_launched' })],
                       [agentFile('ccc3', [user(4, 'x'), asst(5, [{ type: 'tool_use', id: 'q', name: 'Bash', input: {} }])], 5)], {}, T0 + 2_000_000);
    expect(stale.nodes['spawn:toolu_3']).toMatchObject({ status: 'stopped', endTs: T0 + 5000 });
  });

  it('a denied spawn is a dead end', () => {
    const g = base([user(1, 'go'), spawn(2, 'toolu_4', 'Nope'), result(3, 'toolu_4', undefined, 'Permission denied by policy', true)]);
    expect(g.nodes['spawn:toolu_4']).toMatchObject({ kind: 'failed-spawn', status: 'failed', endTs: T0 + 3000, error: 'Permission denied by policy' });
  });

  it('a spawn with no result at all is still running', () => {
    const g = base([user(1, 'go'), spawn(2, 'toolu_5', 'Working')]);
    expect(g.nodes['spawn:toolu_5']!.status).toBe('running');
    expect(bars(g).find(b => b.id === 'spawn:toolu_5')).toMatchObject({ start: T0 + 2000, end: null, depth: 1 });
  });
});

describe('buildGraph — workflows and nesting', () => {
  it('workflow agents hang off the Workflow call, with journal outcomes', () => {
    const main = [user(1, 'go'),
      asst(2, [{ type: 'tool_use', id: 'toolu_w', name: 'Workflow', input: { description: 'Review changes', script: 'export const meta = {}' } }]),
      result(3, 'toolu_w', { runId: 'wf_abc', status: 'async_launched', workflowName: 'review-changes', taskId: 'wb1' }, 'launched')];
    const agents = [
      agentFile('w001', [user(4, 'review bugs'), asst(30, [{ type: 'text', text: 'ok' }], 'end_turn')], 30, 'wf_abc'),
      agentFile('w002', [user(5, 'review perf'), asst(40, [{ type: 'text', text: 'ok' }], 'end_turn')], 40, 'wf_abc'),
    ];
    const g = base(main, agents, { wf_abc: [{ type: 'started', agentId: 'w001' }, { type: 'result', agentId: 'w001' }, { type: 'started', agentId: 'w002' }, { type: 'failed', agentId: 'w002' }] });
    const w = g.nodes['spawn:toolu_w']!;
    expect(w).toMatchObject({ kind: 'workflow', label: 'Review changes', runId: 'wf_abc', status: 'failed', endTs: T0 + 40_000 });
    expect(w.children).toEqual(['orphan:w001', 'orphan:w002']);
    expect(g.nodes['orphan:w001']).toMatchObject({ label: 'review bugs', status: 'completed', parentId: 'spawn:toolu_w' });
    expect(g.nodes['orphan:w002']).toMatchObject({ label: 'review perf', status: 'failed', parentId: 'spawn:toolu_w' });
    expect(g.order).toEqual(['session', 'spawn:toolu_w', 'orphan:w001', 'orphan:w002']);
  });

  it('an agent that spawns a background agent becomes its parent, linked through the task-id', () => {
    const main = [user(1, 'go'), spawn(2, 'toolu_a', 'Orchestrator'), result(3, 'toolu_a', { agentId: 'orch', status: 'async_launched' })];
    const orch = agentFile('orch', [
      user(4, 'orchestrate'),
      spawn(5, 'toolu_b', 'Angle A scan', { run_in_background: true }),
      result(6, 'toolu_b', undefined, [{ type: 'text', text: 'Async agent launched successfully. (This tool result is internal metadata)' }]),
      notif(50, 'angA', 'toolu_b'),
      asst(51, [{ type: 'text', text: 'merged' }], 'end_turn'),
    ], 51);
    const angA = agentFile('angA', [user(7, 'scan angle A'), asst(45, [{ type: 'text', text: 'found' }], 'end_turn')], 45);
    const g = base(main, [orch, angA]);
    expect(g.nodes['spawn:toolu_b']).toMatchObject({ parentId: 'spawn:toolu_a', agentId: 'angA', status: 'completed', endTs: T0 + 50_000, file: angA.path });
    expect(g.nodes['spawn:toolu_a']!.children).toEqual(['spawn:toolu_b']);
    expect(g.order).toEqual(['session', 'spawn:toolu_a', 'spawn:toolu_b']);
  });

  it('an agent file nobody spawned sits under the session with its first prompt as label', () => {
    const g = base([user(1, 'go')], [agentFile('lost', [user(2, 'Investigate the flaky test'), asst(3, [{ type: 'text', text: 'ok' }], 'end_turn')], 3)]);
    expect(g.nodes['orphan:lost']).toMatchObject({ parentId: 'session', label: 'Investigate the flaky test', status: 'completed', spawnTs: T0 + 2000 });
  });

  it('children are ordered by spawn time and bars carry depth', () => {
    const g = base([user(1, 'go'), spawn(5, 'late', 'Late'), spawn(2, 'early', 'Early')]);
    expect(g.nodes.session!.children).toEqual(['spawn:early', 'spawn:late']);
    expect(bars(g).map(b => [b.id, b.depth])).toEqual([['session', 0], ['spawn:early', 1], ['spawn:late', 1]]);
  });
});

describe('buildGraph — decay of file-less launched nodes', () => {
  const launchedWorkflow = (s: number) => [
    asst(s, [{ type: 'tool_use', id: 'toolu_w', name: 'Workflow', input: { description: 'Understand governance', script: '…' } }]),
    result(s + 1, 'toolu_w', { runId: 'wf_dead', status: 'async_launched', taskId: 'wb9' }, 'launched'),
  ];
  it('a launched workflow with no agents is stopped once the session has ended, ending when the session did', () => {
    const g = base([user(1, 'go'), ...launchedWorkflow(2), asst(60, [{ type: 'text', text: 'moving on' }], 'end_turn')]);
    expect(g.nodes.session!.status).toBe('completed');
    expect(g.nodes['spawn:toolu_w']).toMatchObject({ status: 'stopped', endTs: T0 + 60_000 });
  });
  it('in a live session it stays launched while fresh and is stopped once stale', () => {
    const live = (spawnAt: number) => buildGraph({ title: 't', mainFile: '/p/s.jsonl',
      mainRecs: parseRecords([user(1, 'go'), ...launchedWorkflow(spawnAt), asst(spawnAt + 2, [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }])].join('\n')),
      mainMtimeMs: NOW - 1000, agents: [], journals: {}, now: NOW });
    expect(live(590).nodes['spawn:toolu_w']!.status).toBe('launched');       // 8 s ago
    expect(live(2).nodes['spawn:toolu_w']!.status).toBe('launched');         // 10 min ago — under the 15 min stall threshold
    const old = buildGraph({ title: 't', mainFile: '/p/s.jsonl',
      mainRecs: parseRecords([user(1, 'go'), ...launchedWorkflow(2), asst(4, [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }])].join('\n')),
      mainMtimeMs: T0 + 1_999_000, agents: [], journals: {}, now: T0 + 2_000_000 });
    expect(old.nodes['spawn:toolu_w']!.status).toBe('stopped');              // 33 min silent, no file
  });
  it('a background agent WITH a fresh file keeps running after its session ended its turn', () => {
    const g = base([user(1, 'go'), spawn(2, 'toolu_bg', 'Long review', { run_in_background: true }),
                    result(3, 'toolu_bg', { agentId: 'bg1', status: 'async_launched' }),
                    asst(4, [{ type: 'text', text: 'I will wait.' }], 'end_turn')],
                   [agentFile('bg1', [user(5, 'review'), asst(590, [{ type: 'tool_use', id: 'q', name: 'Bash', input: {} }])], 599)]);
    expect(g.nodes.session!.status).toBe('completed');
    expect(g.nodes['spawn:toolu_bg']!.status).toBe('running');
  });
});

describe('buildGraph — labels', () => {
  it('siblings sharing a label get a short id tag, kept apart from the label so truncation cannot eat it', () => {
    const g = base([user(1, 'go')], [agentFile('aaaa1111', [user(2, 'Same prompt')], 2), agentFile('bbbb2222', [user(3, 'Same prompt')], 3)]);
    expect(g.nodes.session!.children.map(id => [g.nodes[id]!.label, g.nodes[id]!.tag])).toEqual([['Same prompt', 'aaaa'], ['Same prompt', 'bbbb']]);
    expect(bars(g).filter(b => b.kind === 'agent').map(b => b.tag)).toEqual(['aaaa', 'bbbb']);
  });
  it('a unique label is left alone', () => {
    const g = base([user(1, 'go')], [agentFile('aaaa1111', [user(2, 'Only child')], 2)]);
    expect(g.nodes['orphan:aaaa1111']!.label).toBe('Only child');
  });
});
