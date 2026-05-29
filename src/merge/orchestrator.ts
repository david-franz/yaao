import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ResolvedPlan, ResolvedTask } from '../plan/schema/types.js';
import type { BranchPlan } from '../git/branch-graph.js';
import type { Git } from '../git/git.js';

export type MergeMode = 'auto' | 'manual' | 'agent';
export type TaskMergePolicy = 'auto' | 'manual' | 'agent' | 'pr' | 'none';

export interface MergePolicy {
  /** Per-run default mode used when a task hits a conflict. */
  onConflict: MergeMode;
}

export interface CompletedTask {
  id: string;
  branch: string;
  mergePolicy: TaskMergePolicy;
}

export interface ConflictContext {
  task: ResolvedTask;
  branch: string;
  files: string[];
  worktreeRoot: string;
}

export type ConflictDecision =
  | { resolved: true; commitMessage?: string; mode: 'auto' | 'agent' }
  | { resolved: false; mode: 'manual' | 'auto' | 'agent'; reason?: string };

export interface ConflictResolver {
  /** Called when a merge conflict happens. Implementation decides what to do. */
  resolve(ctx: ConflictContext): Promise<ConflictDecision>;
}

export interface PrSubmitter {
  /** Push the branch + open a PR. Implementation owns the gh integration. */
  submit(task: ResolvedTask, branch: string): Promise<{ url?: string; error?: string }>;
}

export interface MergeRequest {
  runId: string;
  plan: ResolvedPlan;
  branchPlan: BranchPlan;
  baseBranch: string;
  rootDir: string;
  policy: MergePolicy;
  completedTaskIds: string[];
  /** Optional resolver for conflicts. Defaults to a manual-stop resolver. */
  resolver?: ConflictResolver;
  /** Optional PR submitter for `merge: pr` tasks. */
  prSubmitter?: PrSubmitter;
  /** Test injection. */
  git?: Git;
}

export interface MergeOutcome {
  merged: string[];
  pr: { taskId: string; url?: string; error?: string }[];
  skipped: { taskId: string; reason: string }[];
  conflicts: { taskId: string; files: string[]; mode: MergeMode | 'manual' }[];
  finalCommit: string;
}

export class ManualStopResolver implements ConflictResolver {
  async resolve(ctx: ConflictContext): Promise<ConflictDecision> {
    return {
      resolved: false,
      mode: 'manual',
      reason: `manual resolution required for ${ctx.task.id}: ${ctx.files.join(', ')}`,
    };
  }
}

export async function runMerge(req: MergeRequest): Promise<MergeOutcome> {
  const { git: defaultGit } = await import('../git/git.js');
  const git: Git = req.git ?? defaultGit;
  const resolver = req.resolver ?? new ManualStopResolver();
  const completed = new Set(req.completedTaskIds);
  const taskById = new Map(req.plan.tasks.map((t) => [t.id, t]));
  const order = req.branchPlan.topoOrder.length > 0 ? req.branchPlan.topoOrder : req.plan.tasks.map((t) => t.id);
  // Honour the plan's history strategy, same as the live runner. Falls back to
  // a merge commit when unset.
  const historyMode = req.plan.config.merge?.history === 'rebase' ? 'rebase' : 'merge';

  const outcome: MergeOutcome = {
    merged: [],
    pr: [],
    skipped: [],
    conflicts: [],
    finalCommit: '',
  };
  const blocked = new Set<string>(); // task ids whose downstream we should skip

  // No `git checkout` here: every merge goes through plumbing (git.mergeRefs),
  // so the user's working tree at rootDir is never touched and the target ref
  // is advanced atomically (CAS via update-ref, or `reset --keep` when it is
  // the checked-out branch). This mirrors the concurrency-safe path the live
  // runner uses in exec/lifecycle.ts.

  for (const id of order) {
    const task = taskById.get(id);
    if (!task) continue;
    if (!completed.has(id)) {
      outcome.skipped.push({ taskId: id, reason: 'task did not complete' });
      blocked.add(id);
      continue;
    }
    if (anyAncestorBlocked(task, blocked)) {
      outcome.skipped.push({ taskId: id, reason: 'upstream conflict blocked downstream merge' });
      blocked.add(id);
      continue;
    }
    const policy: TaskMergePolicy = (task.merge.strategy as TaskMergePolicy) ?? 'auto';
    const branchEntry = req.branchPlan.byTask.get(id);
    if (!branchEntry) {
      outcome.skipped.push({ taskId: id, reason: 'no branch entry' });
      continue;
    }

    if (policy === 'none') {
      outcome.skipped.push({ taskId: id, reason: 'merge: none' });
      continue;
    }
    if (policy === 'pr') {
      if (!req.prSubmitter) {
        outcome.skipped.push({ taskId: id, reason: 'merge: pr but no submitter configured' });
        continue;
      }
      const r = await req.prSubmitter.submit(task, branchEntry.branch);
      const entry: MergeOutcome['pr'][number] = { taskId: id };
      if (r.url !== undefined) entry.url = r.url;
      if (r.error !== undefined) entry.error = r.error;
      outcome.pr.push(entry);
      continue;
    }

    // Local merge (auto / manual / agent) via plumbing — no working tree.
    const message = `Merge ${branchEntry.branch} into ${req.baseBranch} (task ${id})`;
    const mergeRes = await git.mergeRefs(
      req.baseBranch,
      branchEntry.branch,
      { message, mode: historyMode },
      req.rootDir,
    );
    if (mergeRes.ok) {
      outcome.merged.push(id);
      continue;
    }

    const taskMode = pickMode(policy, req.policy.onConflict);
    if (taskMode === 'auto' || taskMode === 'manual') {
      // No working tree was touched, so there is nothing to abort or clean up.
      outcome.conflicts.push({ taskId: id, files: mergeRes.conflicts, mode: taskMode });
      blocked.add(id);
      continue;
    }

    // agent mode: resolve the conflict in a throwaway detached worktree so the
    // root working tree stays clean, then advance the target ref atomically.
    const resolved = await resolveConflictInWorktree(
      git,
      req,
      task,
      branchEntry.branch,
      mergeRes.conflicts,
      resolver,
    );
    if (resolved) {
      outcome.merged.push(id);
    } else {
      outcome.conflicts.push({ taskId: id, files: mergeRes.conflicts, mode: 'agent' });
      blocked.add(id);
    }
  }

  outcome.finalCommit = await git.revParse('HEAD', req.rootDir);
  return outcome;
}

/**
 * Resolve an `agent`-mode merge conflict without touching the root working
 * tree. Mirrors the live runner's outgoing-conflict flow (exec/lifecycle.ts):
 * stand up a detached worktree at the target's tip, replay the merge there to
 * surface conflict markers, hand it to the resolver, and — on success —
 * advance the target ref with an atomic CAS keyed on the target's old tip.
 *
 * Returns true on a clean resolution + ref advance, false otherwise (the
 * caller records the conflict and blocks downstream).
 */
async function resolveConflictInWorktree(
  git: Git,
  req: MergeRequest,
  task: ResolvedTask,
  sourceBranch: string,
  conflicts: string[],
  resolver: ConflictResolver,
): Promise<boolean> {
  const targetSha = await git.revParse(req.baseBranch, req.rootDir).catch(() => '');
  if (!targetSha) return false;

  const safe = `${task.id}-into-${req.baseBranch}`.replace(/[^a-zA-Z0-9._-]/g, '_');
  const tmpPath = join(req.rootDir, '.yaao', 'runs', `_merge-${safe}-${req.runId}`);
  try {
    mkdirSync(dirname(tmpPath), { recursive: true });
    await git.worktreeAdd(tmpPath, targetSha, req.rootDir);
  } catch {
    return false;
  }

  try {
    // Populate conflict markers in the throwaway worktree for the resolver.
    const { execa } = await import('execa');
    await execa('git', ['merge', '--no-commit', '--no-ff', sourceBranch], {
      cwd: tmpPath,
      reject: false,
    });

    const decision = await resolver.resolve({
      task,
      branch: sourceBranch,
      files: conflicts,
      worktreeRoot: tmpPath,
    });
    if (!decision.resolved) return false;

    const msg = decision.commitMessage ?? `[merge-resolve] ${task.id} into ${req.baseBranch}`;
    let newHead: string;
    try {
      await git.addAll(tmpPath);
      newHead = await git.commit(msg, undefined, tmpPath);
    } catch {
      // commit failed (e.g. markers remained / nothing staged); treat as conflict.
      return false;
    }
    if (!newHead || newHead === targetSha) return false;

    // CAS: only advances if the target still points at the tip we merged onto.
    await git.advanceRef(req.baseBranch, newHead, targetSha, req.rootDir);
    return true;
  } finally {
    await git.worktreeRemove(tmpPath, { force: true }, req.rootDir).catch(() => undefined);
  }
}

function pickMode(taskPolicy: TaskMergePolicy, defaultMode: MergeMode): MergeMode {
  if (taskPolicy === 'manual' || taskPolicy === 'agent') return taskPolicy;
  return defaultMode;
}

function anyAncestorBlocked(task: ResolvedTask, blocked: Set<string>): boolean {
  for (const dep of task.depends) {
    if (blocked.has(dep)) return true;
  }
  return false;
}
