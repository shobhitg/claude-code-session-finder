/**
 * The session graph for the Session View: who spawned whom, when, with what outcome.
 * Pure — the host reads the files, this joins them.
 *
 * Links, as the transcripts record them (author's corpus, 2026-09-17):
 *  - a spawn is an assistant `tool_use` named Agent (or legacy Task) or Workflow;
 *  - its `tool_result` record carries `toolUseResult.agentId` (foreground: status/tokens/duration too;
 *    background: `status: 'async_launched'`), or `is_error` for a denied/failed spawn;
 *  - a background agent finishes with a `user` record containing `<task-notification>` whose
 *    `<task-id>` is the agentId and `<tool-use-id>` the spawn (the same task may notify more than once);
 *  - agent transcripts live flat in `<session>/subagents/` (or `subagents/workflows/<runId>/`) as
 *    `agent-<agentId>.jsonl` — nesting is reconstructed from these links, never from directories;
 *  - a Workflow's `toolUseResult.runId` names its directory, whose `journal.jsonl` records
 *    started / result / failed per agentId.
 */
import { DEFAULT_THRESHOLDS, type Thresholds } from './state.js';
import { firstPrompt, isNotification, isRecord, parseNotification, resultText, ts,
         type Rec, type ToolResultBlock, type ToolUseBlock } from './transcript.js';

export interface AgentFile { path: string; agentId: string; recs: Rec[]; mtimeMs: number; runId?: string }
export interface JournalRec { type?: string; agentId?: string; key?: string }

export type NodeKind = 'session' | 'agent' | 'workflow' | 'failed-spawn';
export type NodeStatus = 'running' | 'launched' | 'completed' | 'failed' | 'stopped' | 'unknown';
export interface GraphNode {
  id: string; kind: NodeKind; parentId: string | null; label: string;
  subagentType?: string; model?: string; background: boolean;
  spawnTs?: number; launchedTs?: number; endTs?: number;
  status: NodeStatus;
  totalTokens?: number; toolUses?: number; durationMs?: number;
  file?: string; agentId?: string; toolUseId?: string; runId?: string; error?: string;
  children: string[];
}
export interface SessionGraph { root: string; nodes: Record<string, GraphNode>; order: string[] }

export interface GraphInput {
  title: string; mainFile: string; mainRecs: Rec[]; mainMtimeMs: number;
  agents: AgentFile[]; journals: Record<string, JournalRec[]>;
  now: number; thresholds?: Thresholds;
}

const SPAWNERS = new Set(['Agent', 'Task']);
const firstTs = (recs: Rec[]): number | undefined => { for (const r of recs) { const t = ts(r); if (t) return t; } return undefined; };
const lastTs = (recs: Rec[]): number | undefined => { for (let i = recs.length - 1; i >= 0; i--) { const t = ts(recs[i]!); if (t) return t; } return undefined; };
const firstModel = (recs: Rec[]): string | undefined => { for (const r of recs) if (r.type === 'assistant' && r.message?.model) return r.message.model; return undefined; };

/**
 * Like state.ts's classifyTail but over records, and WITHOUT the sidechain skip — inside an agent's
 * own file every record is a sidechain record, and here that is exactly the loop we want to read.
 */
type Verdict = 'turn-ended' | 'in-flight' | 'unknown';
function verdictOf(recs: Rec[]): Verdict {
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i]!;
    if (r.type === 'assistant') return r.message?.stop_reason === 'end_turn' ? 'turn-ended' : 'in-flight';
    if (r.type === 'user') return 'in-flight';
    if (r.type === 'system' && (r.subtype === 'turn_duration' || r.subtype === 'away_summary' || r.subtype === 'local_command')) return 'turn-ended';
  }
  return 'unknown';
}
function liveStatus(recs: Rec[], mtimeMs: number, now: number, th: Thresholds): { status: NodeStatus; endTs?: number } {
  const v = verdictOf(recs);
  if (v === 'turn-ended') return { status: 'completed', endTs: lastTs(recs) };
  if (v === 'unknown') return { status: 'unknown' };
  return now - mtimeMs < th.stalledMs ? { status: 'running' } : { status: 'stopped', endTs: lastTs(recs) };
}

export function buildGraph(input: GraphInput): SessionGraph {
  const th = input.thresholds ?? DEFAULT_THRESHOLDS;
  const nodes: Record<string, GraphNode> = {};
  const containerOf = new Map<string, string | undefined>();          // spawned node id → container agentId (undefined = main)

  const root: GraphNode = { id: 'session', kind: 'session', parentId: null, label: input.title, background: false, status: 'unknown', children: [] };
  const rootFirst = firstTs(input.mainRecs); if (rootFirst) root.spawnTs = rootFirst;
  const rootModel = firstModel(input.mainRecs); if (rootModel) root.model = rootModel;
  Object.assign(root, liveStatus(input.mainRecs, input.mainMtimeMs, input.now, th));
  root.file = input.mainFile;
  nodes[root.id] = root;

  const byAgentId = (agentId: string): GraphNode | undefined => Object.values(nodes).find(n => n.agentId === agentId);

  // pass 1 — every container (main + agent files) contributes the spawns it made
  const containers: Array<{ agentId?: string; recs: Rec[] }> = [{ recs: input.mainRecs }, ...input.agents.map(a => ({ agentId: a.agentId, recs: a.recs }))];
  for (const { agentId: containerAgentId, recs } of containers) {
    for (const r of recs) {
      const t = ts(r); const c = r.message?.content;
      if (r.type === 'assistant' && Array.isArray(c)) {
        for (const b of c) {
          if (b.type !== 'tool_use') continue;
          const tu = b as ToolUseBlock; const inp = tu.input ?? {};
          const isSpawn = SPAWNERS.has(tu.name), isWorkflow = tu.name === 'Workflow';
          if (!isSpawn && !isWorkflow) continue;
          const id = `spawn:${tu.id}`;
          const n: GraphNode = {
            id, kind: isWorkflow ? 'workflow' : 'agent', parentId: null, toolUseId: tu.id,
            label: typeof inp.description === 'string' && inp.description ? inp.description : (isWorkflow ? 'workflow' : 'agent'),
            background: inp.run_in_background === true, status: 'running', children: [],
          };
          if (t) n.spawnTs = t;
          if (typeof inp.subagent_type === 'string') n.subagentType = inp.subagent_type;
          if (typeof inp.model === 'string') n.model = inp.model;
          nodes[id] = n; containerOf.set(id, containerAgentId);
        }
      } else if (r.type === 'user' && Array.isArray(c)) {
        for (const b of c) {
          if (b.type !== 'tool_result') continue;
          const tr = b as ToolResultBlock; const n = nodes[`spawn:${tr.tool_use_id}`];
          if (!n) continue;
          applyResult(n, tr, r.toolUseResult, t);
        }
      } else if (r.type === 'user' && typeof c === 'string' && isNotification(c)) {
        const nt = parseNotification(c);
        const n = (nt.toolUseId && nodes[`spawn:${nt.toolUseId}`]) || (nt.taskId ? byAgentId(nt.taskId) : undefined);
        if (!n) continue;
        if (t) n.endTs = t;
        if (nt.status === 'completed') n.status = 'completed';
        else if (nt.status === 'failed' || nt.status === 'error') n.status = 'failed';
        else if (nt.status === 'stopped' || nt.status === 'killed') n.status = 'stopped';
        if (!n.agentId && nt.taskId) n.agentId = nt.taskId;
      }
    }
  }

  // pass 2 — agent files: attach to their node, or stand in as orphans; read journals and live tails
  for (const a of input.agents) {
    let n = byAgentId(a.agentId);
    if (!n) {
      n = { id: `orphan:${a.agentId}`, kind: 'agent', parentId: null, label: firstPrompt(a.recs) ?? a.agentId.slice(0, 8),
            background: false, status: 'unknown', agentId: a.agentId, children: [] };
      if (a.runId) n.runId = a.runId;
      nodes[n.id] = n;
    }
    n.file = a.path;
    if (!n.model) { const m = firstModel(a.recs); if (m) n.model = m; }
    if (!n.spawnTs) { const f = firstTs(a.recs); if (f) n.spawnTs = f; }
    if (a.runId && !n.runId) n.runId = a.runId;
    const journal = a.runId ? input.journals[a.runId] : undefined;
    if (journal) {
      const mine = journal.filter(j => j.agentId === a.agentId);
      if (mine.some(j => j.type === 'failed')) n.status = 'failed';
      else if (mine.some(j => j.type === 'result')) n.status = 'completed';
    }
    if (!n.endTs && (n.status === 'running' || n.status === 'launched' || n.status === 'unknown')) {
      const live = liveStatus(a.recs, a.mtimeMs, input.now, th);
      if (live.status !== 'unknown') { n.status = live.status; if (live.endTs) n.endTs = live.endTs; }
    } else if (!n.endTs && (n.status === 'completed' || n.status === 'failed')) {
      const l = lastTs(a.recs); if (l) n.endTs = l;
    }
  }

  // pass 3 — parents: the container's node (main → session), workflow agents → their run's node
  const workflowByRun = (runId: string): GraphNode => {
    let w = Object.values(nodes).find(n => n.kind === 'workflow' && n.runId === runId);
    if (!w) {
      w = { id: `workflow:${runId}`, kind: 'workflow', parentId: root.id, label: runId, background: true, status: 'unknown', runId, children: [] };
      nodes[w.id] = w;
    }
    return w;
  };
  for (const n of Object.values(nodes)) {
    if (n === root || n.parentId) continue;
    if (containerOf.has(n.id)) {
      const containerAgentId = containerOf.get(n.id);
      n.parentId = containerAgentId ? (byAgentId(containerAgentId)?.id ?? root.id) : root.id;
    } else if (n.kind === 'agent' && n.runId) {
      n.parentId = workflowByRun(n.runId).id;
    } else {
      n.parentId = root.id;
    }
  }
  for (const n of Object.values(nodes)) if (n.parentId) nodes[n.parentId]?.children.push(n.id);
  const bySpawn = (a: string, b: string): number => (nodes[a]?.spawnTs ?? 0) - (nodes[b]?.spawnTs ?? 0);
  for (const n of Object.values(nodes)) n.children.sort(bySpawn);
  // a workflow with children and no own outcome takes the worst child outcome
  for (const n of Object.values(nodes)) {
    if (n.kind !== 'workflow' || n.endTs || n.children.length === 0) continue;
    const kids = n.children.map(id => nodes[id]!);
    if (kids.every(k => k.status === 'completed' || k.status === 'failed' || k.status === 'stopped')) {
      n.status = kids.some(k => k.status === 'failed') ? 'failed' : 'completed';
      const ends = kids.map(k => k.endTs ?? 0); n.endTs = Math.max(...ends) || undefined;
    } else if (kids.some(k => k.status === 'running')) n.status = 'running';
  }

  const order: string[] = [];
  const walk = (id: string): void => { order.push(id); for (const c of nodes[id]!.children) walk(c); };
  walk(root.id);
  return { root: root.id, nodes, order };
}

function applyResult(n: GraphNode, tr: ToolResultBlock, tur: unknown, t: number): void {
  if (isRecord(tur)) {
    if (typeof tur.agentId === 'string') n.agentId = tur.agentId;
    if (typeof tur.runId === 'string') n.runId = tur.runId;
    if (typeof tur.workflowName === 'string' && (n.label === 'workflow' || !n.label)) n.label = tur.workflowName;
    if (typeof tur.resolvedModel === 'string') n.model = tur.resolvedModel;
    if (typeof tur.agentType === 'string') n.subagentType = tur.agentType;
    if (typeof tur.totalTokens === 'number') n.totalTokens = tur.totalTokens;
    if (typeof tur.totalToolUseCount === 'number') n.toolUses = tur.totalToolUseCount;
    if (typeof tur.totalDurationMs === 'number') n.durationMs = tur.totalDurationMs;
    if (tur.status === 'async_launched') { n.status = 'launched'; if (t) n.launchedTs = t; return; }
    if (t) n.endTs = t;
    n.status = tur.status === 'failed' || tr.is_error ? 'failed' : 'completed';
    return;
  }
  // No structured result: a denied/failed spawn, or (inside agent files) a bare text result.
  const { text } = resultText(tr);
  if (tr.is_error) { n.kind = 'failed-spawn'; n.status = 'failed'; if (t) n.endTs = t; n.error = text.slice(0, 200); return; }
  if (/Async agent launched/i.test(text)) { n.status = 'launched'; if (t) n.launchedTs = t; return; }
  if (t) n.endTs = t;
  n.status = 'completed';
}

/** Timeline bars: one per node with a start; open-ended while running. */
export interface Bar { id: string; start: number; end: number | null; kind: NodeKind; status: NodeStatus; label: string; depth: number }
export function bars(g: SessionGraph): Bar[] {
  const depth = new Map<string, number>();
  const out: Bar[] = [];
  for (const id of g.order) {
    const n = g.nodes[id]!;
    const d = n.parentId ? (depth.get(n.parentId) ?? 0) + 1 : 0;
    depth.set(id, d);
    if (!n.spawnTs) continue;
    const end = n.endTs ?? (n.status === 'running' || n.status === 'launched' ? null : (n.launchedTs ?? n.spawnTs));
    out.push({ id, start: n.spawnTs, end, kind: n.kind, status: n.status, label: n.label, depth: d });
  }
  return out;
}
