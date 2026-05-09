import type { ResolvedPlan, ResolvedTask } from '../plan/schema/types.js';
import type { BranchPlan } from '../git/branch-graph.js';
import type { Git, MergeResult } from '../git/git.js';

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

  const outcome: MergeOutcome = {
    merged: [],
    pr: [],
    skipped: [],
    conflicts: [],
    finalCommit: '',
  };
  const blocked = new Set<string>(); // task ids whose downstream we should skip

  // Make sure we're on the base branch.
  await rawCheckout(git, req.baseBranch, req.rootDir);

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
    const policy: TaskMergePolicy = (task.merge as TaskMergePolicy) ?? 'auto';
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

    // Local merge (auto / manual / agent)
    const mergeRes: MergeResult = await git.merge(branchEntry.branch, { ff: false }, req.rootDir);
    if (mergeRes.ok) {
      outcome.merged.push(id);
      continue;
    }
    // Conflict. Abort first, then call resolver; in manual/auto modes we don't write markers
    // unless the resolver opts in.
    await git.mergeAbort(req.rootDir).catch(() => {
      // ignore
    });

    const taskMode = pickMode(policy, req.policy.onConflict);
    if (taskMode === 'auto') {
      outcome.conflicts.push({ taskId: id, files: mergeRes.conflicts, mode: 'auto' });
      blocked.add(id);
      continue;
    }
    if (taskMode === 'manual') {
      outcome.conflicts.push({ taskId: id, files: mergeRes.conflicts, mode: 'manual' });
      blocked.add(id);
      continue;
    }

    // agent mode: redo the merge to populate markers, then call resolver.
    await rawMergeNoCommit(git, branchEntry.branch, req.rootDir);
    const decision = await resolver.resolve({
      task,
      branch: branchEntry.branch,
      files: mergeRes.conflicts,
      worktreeRoot: req.rootDir,
    });
    if (decision.resolved) {
      const msg = decision.commitMessage ?? `[merge-resolve] ${task.id} into ${req.baseBranch}`;
      try {
        await git.addAll(req.rootDir);
        const sha = await git.commit(msg, undefined, req.rootDir);
        outcome.merged.push(id);
        void sha;
      } catch (err) {
        // commit failed (e.g., still markers); abort and treat as conflict.
        await git.mergeAbort(req.rootDir).catch(() => undefined);
        outcome.conflicts.push({
          taskId: id,
          files: mergeRes.conflicts,
          mode: 'agent',
        });
        blocked.add(id);
        void err;
      }
    } else {
      await git.mergeAbort(req.rootDir).catch(() => undefined);
      outcome.conflicts.push({ taskId: id, files: mergeRes.conflicts, mode: decision.mode });
      blocked.add(id);
    }
  }

  outcome.finalCommit = await git.revParse('HEAD', req.rootDir);
  return outcome;
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

async function rawCheckout(_git: Git, branch: string, cwd: string): Promise<void> {
  const { execa } = await import('execa');
  await execa('git', ['checkout', branch], { cwd, reject: false });
}

async function rawMergeNoCommit(_git: Git, branch: string, cwd: string): Promise<void> {
  const { execa } = await import('execa');
  await execa('git', ['merge', '--no-commit', '--no-ff', branch], { cwd, reject: false });
}
