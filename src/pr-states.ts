import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { stalePrs, prQuery, readPrStates, prInfoOf, prunePrCache, prKey, type PrCache, type PrRef } from './core/pr-states.js';
import type { PrInfo } from './core/rows.js';
import type { PrLink } from './core/types.js';

/** globalState key: what GitHub said about each PR (core/pr-states.ts). Machine-wide, like the sessions. */
const CACHE_KEY = 'prStates';
const PER_QUERY = 100;
const KEEP = 3_000;
const AFTER_FAILURE_MS = 30 * 60_000;

const readEnabled = (): boolean => vscode.workspace.getConfiguration('sessionFinder').get<boolean>('prStates', true);

/** gh's output even when it exits non-zero: a query naming one unknown PR fails as a whole yet prints the data it has. */
function gh(args: string[]): Promise<{ stdout: string; error?: string }> {
  return new Promise(resolve => {
    execFile('gh', args, { timeout: 20_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' } },
      (err, stdout) => resolve({ stdout: String(stdout ?? ''), ...(err ? { error: err.message.split('\n')[0] } : {}) }));
  });
}

/**
 * What each PR the sidebar shows is now — open, merged, closed or draft — with its title and head branch,
 * asked of GitHub through the GitHub CLI (`gh`, signed in) and remembered machine-wide. One query at a time,
 * a hundred PRs at most; merged and closed PRs are never asked about again. When `gh` is missing, signed out
 * or offline, nothing is coloured and the next try waits half an hour. The `sessionFinder.prStates` setting
 * turns it off.
 */
export class PrStates {
  private cache: PrCache;
  private busy = false;
  private retryAt = 0;
  /** the setting, read once and on change — info() runs for every PR on every snapshot */
  private enabled = readEnabled();

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly log: vscode.LogOutputChannel, private readonly changed: () => void) {
    this.cache = ctx.globalState.get<PrCache>(CACHE_KEY) ?? {};
    ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('sessionFinder.prStates')) return;
      this.enabled = readEnabled(); this.retryAt = 0;
      changed();                                            // recolour (or uncolour) the rows now
    }));
  }

  readonly info = (p: PrLink): PrInfo | undefined =>
    this.enabled && p.repo ? prInfoOf(this.cache[prKey(p.repo, p.n)]) : undefined;

  /** Called with the PRs on screen, on every snapshot: cheap when nothing is stale; asks in the background when something is. */
  want(prs: ReadonlyArray<{ repo: string | null; n: number; url: string | null }>): void {
    if (this.busy || Date.now() < this.retryAt || !this.enabled) return;
    const ask = stalePrs(prs, this.cache, Date.now()).slice(0, PER_QUERY);
    if (!ask.length) return;
    this.busy = true;
    void this.ask(ask).finally(() => { this.busy = false; });
  }

  private async ask(ask: PrRef[]): Promise<void> {
    const started = Date.now();
    const out = await gh(['api', 'graphql', '-f', `query=${prQuery(ask)}`]);
    let data: unknown = null;
    try { data = (JSON.parse(out.stdout) as { data?: unknown }).data ?? null; } catch { /* not JSON: gh missing, signed out, offline */ }
    if (data === null) {
      this.retryAt = Date.now() + AFTER_FAILURE_MS;
      this.log.warn(`PR states: GitHub could not be asked (${out.error ?? 'no data'}) — trying again in 30 minutes`);
      return;
    }
    this.cache = prunePrCache({ ...this.cache, ...readPrStates(data, ask, Date.now()) }, KEEP);
    await this.ctx.globalState.update(CACHE_KEY, this.cache);
    this.log.info(`PR states: asked GitHub about ${ask.length} PR(s) in ${Date.now() - started} ms`);
    this.changed();
  }
}
