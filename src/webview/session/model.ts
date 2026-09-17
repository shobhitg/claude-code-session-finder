/** Pure view-model for the Session View: tree rows, timeline lane packing, labels. Tested in node. */
import type { Bar, GraphNode, NodeKind, NodeStatus, SessionGraph } from '../../core/agents.js';
import { fmtDuration } from '../model.js';

export function statusIcon(kind: NodeKind, status: NodeStatus, reducedMotion = false): string {
  if (status === 'running' || status === 'launched') return reducedMotion ? 'circle-large-filled' : 'loading~spin';
  if (kind === 'failed-spawn' || status === 'failed') return 'error';
  if (status === 'stopped') return 'circle-slash';
  if (status === 'completed') return kind === 'workflow' ? 'type-hierarchy' : 'check';
  return 'circle-large-outline';
}

export function iconClasses(name: string): string {
  const [base, mod] = name.split('~');
  return `codicon codicon-${base}${mod ? ` codicon-modifier-${mod}` : ''}`;
}

export function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

const pad = (n: number): string => String(n).padStart(2, '0');
export function fmtClock(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The second line of a tree row: what the node did, in numbers. */
export function nodeMeta(n: GraphNode, now: number): string {
  const bits: string[] = [];
  if (n.kind === 'failed-spawn') bits.push('spawn failed');
  else if (n.status === 'running' || n.status === 'launched') bits.push(`running · ${fmtDuration(now - (n.spawnTs ?? now))}`);
  else if (n.durationMs) bits.push(fmtDuration(n.durationMs));
  else if (n.spawnTs && n.endTs) bits.push(fmtDuration(n.endTs - n.spawnTs));
  if (n.totalTokens) bits.push(`${fmtTokens(n.totalTokens)} tokens`);
  if (n.toolUses) bits.push(`${n.toolUses} tools`);
  if (n.model && n.kind !== 'session') bits.push(n.model.replace(/^claude-/, ''));
  if (n.background) bits.push('background');
  return bits.join(' · ');
}

export interface TreeRow { id: string; depth: number; label: string; meta: string; icon: string; status: NodeStatus; kind: NodeKind; live: boolean }

export function treeRows(g: SessionGraph, now: number, reducedMotion = false): TreeRow[] {
  const depth = new Map<string, number>();
  const rows: TreeRow[] = [];
  for (const id of g.order) {
    const n = g.nodes[id]; if (!n) continue;
    const d = n.parentId ? (depth.get(n.parentId) ?? 0) + 1 : 0;
    depth.set(id, d);
    rows.push({ id, depth: d, label: n.label, meta: nodeMeta(n, now), icon: statusIcon(n.kind, n.status, reducedMotion),
                status: n.status, kind: n.kind, live: n.status === 'running' || n.status === 'launched' });
  }
  return rows;
}

export interface PlacedBar { bar: Bar; lane: number; x0: number; x1: number; open: boolean }
export interface TimelineLayout { placed: PlacedBar[]; lanes: number; start: number; end: number; ticks: Array<{ x: number; label: string }> }

/**
 * Greedy lane packing in start order: a bar takes the first lane whose last bar ended before it
 * started. The session bar spans everything and so keeps lane 0 to itself — a baseline the agents
 * hang under. x0/x1 are fractions of [start, end]; an open bar runs to `now`.
 */
export function layoutTimeline(bars: Bar[], now: number): TimelineLayout {
  if (bars.length === 0) return { placed: [], lanes: 0, start: now, end: now, ticks: [] };
  const start = Math.min(...bars.map(b => b.start));
  const end = Math.max(...bars.map(b => b.end ?? now), start + 1);
  const span = end - start;
  const sorted = [...bars].sort((a, b) => a.start - b.start || (a.end ?? Infinity) - (b.end ?? Infinity));
  const laneEnds: number[] = [];
  const placed: PlacedBar[] = [];
  for (const bar of sorted) {
    const e = bar.end ?? now;
    let lane = laneEnds.findIndex(le => le <= bar.start);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(e); } else laneEnds[lane] = e;
    const x0 = (bar.start - start) / span;
    placed.push({ bar, lane, x0, x1: Math.max((e - start) / span, x0 + 0.003), open: bar.end === null });
  }
  const ticks: Array<{ x: number; label: string }> = [];
  const n = 5;
  for (let i = 0; i <= n; i++) ticks.push({ x: i / n, label: fmtClock(start + (span * i) / n) });
  return { placed, lanes: laneEnds.length, start, end, ticks };
}

export function toolIcon(name: string): string {
  switch (name) {
    case 'Bash': return 'terminal';
    case 'Read': return 'file';
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return 'edit';
    case 'Write': return 'new-file';
    case 'Agent': case 'Task': return 'type-hierarchy-sub';
    case 'Workflow': return 'type-hierarchy';
    case 'Grep': case 'Glob': case 'ToolSearch': return 'search';
    case 'WebFetch': case 'WebSearch': return 'globe';
    case 'Skill': return 'sparkle';
    case 'AskUserQuestion': return 'question';
    case 'SendMessage': return 'comment';
    default: return 'tools';
  }
}
