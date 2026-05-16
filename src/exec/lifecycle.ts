import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import type { ResolvedPlan, ResolvedTask } from '../plan/schema/types.js';
import type { Scheduler } from './scheduler.js';
import type { WorktreeManager } from '../git/worktree-manager.js';
import type { Git } from '../git/git.js';
import type { BranchPlan } from '../git/branch-graph.js';
import type { AgentBackend, McpServerConfig } from '../agents/backend.js';
import type { RunBus } from './bus.js';
import type { RunJournal } from '../git/journal.js';
import { writeContextMd, buildContextPrefix, type TaskOutcomeArtifact } from './context.js';
import { YaaoError, AgentNonZeroExitError } from '../log/errors.js';

export interface LifecycleOptions {
  runId: string;
  plan: ResolvedPlan;
  scheduler: Scheduler;
  worktreeManager: WorktreeManager;
  branchPlan: BranchPlan;
  bus: RunBus;
  journal: RunJournal;
  git: Git;
  rootDir: string;
  /** Resolved agents per task (the runner picks these from the registry). */
  backendFor: (task: ResolvedTask) => AgentBackend;
  /** Directory used to materialize per-task context.md artifacts. */
  runDir: string;
  /** Default base directory used to resolve `prompt-ref:` paths. */
  promptRefBaseDir?: string;
  /** MCP servers visible to every spawned agent (F7.2). */
  mcpServers?: McpServerConfig[];
  /** Optional system-prompt directive prepended to every task (F7.3). */
  ctxSysDirective?: string;
}

export class Lifecycle {
  constructor(private readonly opts: LifecycleOptions) {}

  async runTask(task: ResolvedTask): Promise<void> {
    const start = Date.now();
    const branchEntry = this.opts.branchPlan.byTask.get(task.id);
    if (!branchEntry) {
      this.opts.scheduler.failTask(
        task.id,
        new YaaoError({ code: 'YAAO_LIFECYCLE', message: `branch entry missing for ${task.id}` }),
      );
      return;
    }

    let stdout = '';
    try {
      // 1) Provision worktree
      const wt = await this.opts.worktreeManager.create({
        runId: this.opts.runId,
        taskId: task.id,
        branch: branchEntry.branch,
        baseBranch: branchEntry.baseBranch,
        parentBranches: branchEntry.parentBranches,
        rootDir: this.opts.rootDir,
        worktreeRoot: this.opts.plan.config['worktree-root'],
      });

      // 1.5) Pre-task setup: run any shell commands declared in `task.setup`
      // inside the worktree. Lets a plan bootstrap dependencies (pnpm install,
      // docker compose up -d, etc.) before the agent ever spawns, so the
      // agent doesn't waste turns trying to ask for permission to do so.
      for (const cmd of task.setup ?? []) {
        // eslint-disable-next-line no-await-in-loop -- setup commands run sequentially
        const r = await this.runShell(cmd, wt.path);
        if (r.exitCode !== 0) {
          throw new YaaoError({
            code: 'YAAO_TASK_SETUP_FAILED',
            message: `setup command failed for ${task.id}: \`${cmd}\` exited ${r.exitCode}`,
          });
        }
      }

      // 2) Resolve prompt body (inline or from prompt-ref) and prepend context prefix.
      const promptBody = resolvePromptBody(task, this.opts.promptRefBaseDir ?? this.opts.rootDir);
      const { prefix } = buildContextPrefix({
        runDir: this.opts.runDir,
        plan: this.opts.plan,
        task,
      });
      const prompt = `${prefix}${promptBody}`;
      const systemPrompt = computeSystemPrompt(task, this.opts.ctxSysDirective);

      // 3) Spawn agent
      const backend = this.opts.backendFor(task);
      await this.opts.journal.append({
        t: 'task:running',
        time: new Date().toISOString(),
        taskId: task.id,
        agent: backend.name,
        ...(task.model !== undefined ? { model: task.model } : {}),
        worktree: wt.path,
        branch: wt.branch,
        pid: 0,
      });
      const proc = await backend.spawn({
        cwd: wt.path,
        prompt,
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        ...(task.model !== undefined ? { model: task.model } : {}),
        ...(task.skills !== undefined ? { skills: task.skills } : {}),
        env: task.env,
        permissions: task.permissions,
        ...(task.timeout !== undefined ? { timeout: parseDuration(task.timeout) } : {}),
        ...(this.opts.mcpServers && this.opts.mcpServers.length > 0
          ? { mcpServers: this.opts.mcpServers }
          : {}),
        ...(task.api !== undefined
          ? {
              api: {
                provider: task.api.provider,
                model: task.api.model,
                ...(task.api['base-url'] !== undefined ? { baseUrl: task.api['base-url'] } : {}),
              },
            }
          : {}),
      });

      // Forward agent events into the run bus + capture per-task output to disk
      // for `yaao status --task` (F11.4).
      const outputDir = join(this.opts.runDir, task.id);
      const outputLog = join(outputDir, 'output.log');
      const { mkdirSync, appendFileSync } = await import('node:fs');
      mkdirSync(outputDir, { recursive: true });
      void (async () => {
        for await (const ev of proc.events) {
          this.opts.bus.emit({ type: 'task:agent-event', taskId: task.id, ev });
          if (ev.type === 'stdout' || ev.type === 'stderr') {
            try {
              appendFileSync(outputLog, ev.data.endsWith('\n') ? ev.data : `${ev.data}\n`);
            } catch {
              // ignore — log capture is best-effort
            }
          }
        }
      })();

      const result = await proc.completed;
      stdout = result.stdout;

      // 4) Validation command (optional)
      if (task.validation?.command) {
        const v = await this.runShell(task.validation.command, wt.path);
        if (v.exitCode !== 0 && task.validation['must-pass']) {
          throw new AgentNonZeroExitError({
            message: `validation failed for ${task.id}: ${task.validation.command} exited ${v.exitCode}`,
            agent: backend.name,
            exitCode: v.exitCode,
          });
        }
      }

      // 5) Commit changes if present
      const commitOutcome = await this.commitIfDirty(task, wt.path, stdout);

      // 6) Capture diff stats vs base
      const diffStats = await this.computeDiffStats(wt.path, branchEntry.baseBranch);
      this.opts.bus.emit({
        type: 'task:diff',
        taskId: task.id,
        filesChanged: diffStats.filesChanged,
        insertions: diffStats.insertions,
        deletions: diffStats.deletions,
      });

      // 6.5) Optional per-task merge: route the task's commits into a chosen
      // target branch (e.g. a phase branch) before reporting completion. Failure
      // here is non-fatal — the task succeeded; we surface the merge problem so
      // the user can resolve it without losing the task's work.
      if (commitOutcome.commit && task.merge.into && task.merge.when === 'completed') {
        await this.mergeIntoTarget(task, wt.branch, branchEntry.baseBranch);
      }

      // 7) Write context.md artifact
      const artifact: TaskOutcomeArtifact = {
        branch: wt.branch,
        filesChanged: diffStats.filesChanged,
        insertions: diffStats.insertions,
        deletions: diffStats.deletions,
        files: diffStats.files,
        summary: stdout,
        ...(commitOutcome.commit !== undefined ? { commit: commitOutcome.commit } : {}),
        ...(commitOutcome.subject !== undefined ? { commitSubject: commitOutcome.subject } : {}),
      };
      writeContextMd(this.opts.runDir, task, artifact);

      // 8) Notify scheduler + journal
      const durationMs = Date.now() - start;
      this.opts.scheduler.completeTask(task.id, {
        filesChanged: diffStats.filesChanged,
        ...(commitOutcome.commit !== undefined ? { commit: commitOutcome.commit } : {}),
        durationMs,
      });
      await this.opts.journal.append({
        t: 'task:completed',
        time: new Date().toISOString(),
        taskId: task.id,
        durationMs,
        filesChanged: diffStats.filesChanged,
        commit: commitOutcome.commit ?? '',
      });
    } catch (err) {
      const durationMs = Date.now() - start;
      const yerr =
        err instanceof YaaoError
          ? err
          : new YaaoError({
              code: 'YAAO_LIFECYCLE',
              message: (err as Error).message,
              cause: err,
            });
      // We intentionally do NOT tear down the worktree/branch here. Leaving
      // them on disk lets the user inspect what the agent produced and cherry-
      // pick anything worth keeping. `yaao clean <run-id>` is the documented
      // way to reclaim that state once the user is done. `yaao run --force`
      // also offers an opt-in shortcut to wipe colliding leftovers on retry.
      this.opts.scheduler.failTask(task.id, yerr);
      await this.opts.journal.append({
        t: 'task:failed',
        time: new Date().toISOString(),
        taskId: task.id,
        durationMs,
        error: { code: yerr.code, message: yerr.message },
      });
    }
  }

  private async runShell(cmd: string, cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const { execa } = await import('execa');
    const r = await execa('sh', ['-c', cmd], { cwd, reject: false });
    return {
      exitCode: typeof r.exitCode === 'number' ? r.exitCode : -1,
      stdout: r.stdout?.toString() ?? '',
      stderr: r.stderr?.toString() ?? '',
    };
  }

  /**
   * Merge a completed task's branch into a target branch (e.g. a phase branch).
   * Uses a transient worktree so we never touch the user's main checkout. The
   * target branch is created off `base` if missing and `create-if-missing` is
   * set. Conflicts surface as a `task:merge-failed` event without failing the
   * task itself — the agent's work is preserved on its own branch.
   */
  private async mergeIntoTarget(
    task: ResolvedTask,
    sourceBranch: string,
    baseBranch: string,
  ): Promise<void> {
    const target = task.merge.into;
    if (!target) return;
    const rootDir = this.opts.rootDir;
    const exists = await this.opts.git.branchExists(target, rootDir);
    if (!exists) {
      if (!task.merge['create-if-missing']) {
        this.opts.bus.emit({
          type: 'task:merge-failed',
          taskId: task.id,
          into: target,
          reason: `target branch '${target}' does not exist and create-if-missing is false`,
          conflicts: [],
        });
        return;
      }
      try {
        await this.opts.git.createBranch(target, baseBranch, rootDir);
      } catch (err) {
        this.opts.bus.emit({
          type: 'task:merge-failed',
          taskId: task.id,
          into: target,
          reason: `could not create target branch '${target}': ${(err as Error).message}`,
          conflicts: [],
        });
        return;
      }
    }

    // Transient checkout used purely for this merge. The path lives under the
    // run dir so `yaao clean` reclaims it alongside the rest of the run.
    const safe = target.replace(/[^a-zA-Z0-9._-]/g, '_');
    const mergePath = join(this.opts.runDir, '_merge', safe);
    try {
      await this.opts.git.worktreeAdd(mergePath, target, rootDir);
    } catch (err) {
      this.opts.bus.emit({
        type: 'task:merge-failed',
        taskId: task.id,
        into: target,
        reason: `could not check out target: ${(err as Error).message}`,
        conflicts: [],
      });
      return;
    }
    try {
      const result = await this.opts.git.merge(
        sourceBranch,
        { ff: false, noEdit: true, message: `Merge ${sourceBranch} into ${target} (task ${task.id})` },
        mergePath,
      );
      if (!result.ok) {
        try {
          await this.opts.git.mergeAbort(mergePath);
        } catch {
          // ignore — already in failure path
        }
        this.opts.bus.emit({
          type: 'task:merge-failed',
          taskId: task.id,
          into: target,
          reason: `merge conflicts (${result.conflicts.length} file(s))`,
          conflicts: result.conflicts,
        });
        return;
      }
      this.opts.bus.emit({
        type: 'task:merged',
        taskId: task.id,
        into: target,
        mergeCommit: result.mergeCommit ?? '',
      });
    } finally {
      try {
        await this.opts.git.worktreeRemove(mergePath, { force: true }, rootDir);
      } catch {
        // ignore — `yaao clean` will reclaim it
      }
    }
  }

  private async commitIfDirty(
    task: ResolvedTask,
    cwd: string,
    transcript: string,
  ): Promise<{ commit?: string; subject?: string }> {
    const status = await this.opts.git.status(cwd);
    if (status.files.length === 0 && status.untracked.length === 0) {
      return {};
    }
    const subject = `[${task.id}] ${task.title}`;
    const body = transcript.trim().split(/\r?\n/).slice(-40).join('\n');
    const message = body ? `${subject}\n\n${body}` : subject;
    await this.opts.git.addAll(cwd);
    const sha = await this.opts.git.commit(message, undefined, cwd);
    this.opts.bus.emit({ type: 'task:committed', taskId: task.id, sha });
    return { commit: sha, subject };
  }

  private async computeDiffStats(
    cwd: string,
    baseBranch: string,
  ): Promise<{ filesChanged: number; insertions: number; deletions: number; files: TaskOutcomeArtifact['files'] }> {
    const out = { filesChanged: 0, insertions: 0, deletions: 0, files: [] as TaskOutcomeArtifact['files'] };
    let nameStatus: string;
    let numstat: string;
    try {
      nameStatus = await this.opts.git.diff({ rangeBase: baseBranch, nameOnly: false }, cwd);
      // git diff --name-status base...HEAD
      // we already used rangeBase: but our diff() doesn't accept name-status flag.
      const { execa } = await import('execa');
      const ns = await execa('git', ['diff', '--name-status', `${baseBranch}...HEAD`], { cwd, reject: false });
      nameStatus = ns.stdout?.toString() ?? '';
      const num = await execa('git', ['diff', '--numstat', `${baseBranch}...HEAD`], { cwd, reject: false });
      numstat = num.stdout?.toString() ?? '';
    } catch {
      return out;
    }
    for (const line of nameStatus.split(/\r?\n/)) {
      if (!line) continue;
      const parts = line.split('\t');
      const code = parts[0] ?? '';
      const path = parts[parts.length - 1] ?? '';
      if (!path) continue;
      let status: TaskOutcomeArtifact['files'][number]['status'] = 'modified';
      if (code.startsWith('A')) status = 'added';
      else if (code.startsWith('D')) status = 'removed';
      else if (code.startsWith('R')) status = 'renamed';
      out.files.push({ path, status });
    }
    out.filesChanged = out.files.length;
    for (const line of numstat.split(/\r?\n/)) {
      if (!line) continue;
      const [insStr, delStr] = line.split('\t');
      const ins = Number(insStr ?? '0');
      const del = Number(delStr ?? '0');
      if (Number.isFinite(ins)) out.insertions += ins;
      if (Number.isFinite(del)) out.deletions += del;
    }
    return out;
  }
}

function resolvePromptBody(task: ResolvedTask, baseDir: string): string {
  if (task.prompt) return task.prompt;
  const ref = task['prompt-ref'];
  if (!ref) return '';
  const abs = isAbsolute(ref) ? ref : resolvePath(baseDir, ref);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : '';
}

function computeSystemPrompt(task: ResolvedTask, ctxSysDirective: string | undefined): string | undefined {
  // Per-task suppression beats the global directive.
  const taskCtxSys = task.context?.['ctx-sys'];
  if (taskCtxSys && (taskCtxSys as { directive?: boolean }).directive === false) {
    return undefined;
  }
  if (taskCtxSys?.['require-query']) {
    return 'Before writing or modifying code, call the `context_query` MCP tool to retrieve relevant context from this codebase.';
  }
  return ctxSysDirective;
}

function parseDuration(d: string): number {
  const m = d.match(/^(\d+)(ms|s|m|h)$/);
  if (!m) return 0;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'ms':
      return n;
    case 's':
      return n * 1000;
    case 'm':
      return n * 60_000;
    case 'h':
      return n * 3_600_000;
    default:
      return 0;
  }
}
