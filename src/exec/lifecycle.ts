import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import type { ResolvedPlan, ResolvedTask } from '../plan/schema/types.js';
import type { Scheduler } from './scheduler.js';
import type { WorktreeManager } from '../git/worktree-manager.js';
import type { Git, MergeResult } from '../git/git.js';
import type { BranchPlan } from '../git/branch-graph.js';
import type { AgentBackend } from '../agents/backend.js';
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

    let worktreePath: string | undefined;
    let stdout = '';
    let exitCode = 0;
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
      worktreePath = wt.path;

      // 2) Resolve prompt body (inline or from prompt-ref) and prepend context prefix.
      const promptBody = resolvePromptBody(task, this.opts.promptRefBaseDir ?? this.opts.rootDir);
      const { prefix } = buildContextPrefix({
        runDir: this.opts.runDir,
        plan: this.opts.plan,
        task,
      });
      const prompt = `${prefix}${promptBody}`;
      const systemPrompt = task.context?.['ctx-sys']?.['require-query']
        ? 'Before writing or modifying code, call the `context_query` MCP tool to retrieve relevant context from this codebase.'
        : undefined;

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
        ...(task.timeout !== undefined ? { timeout: parseDuration(task.timeout) } : {}),
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

      // Forward agent events into the run bus.
      void (async () => {
        for await (const ev of proc.events) {
          this.opts.bus.emit({ type: 'task:agent-event', taskId: task.id, ev });
        }
      })();

      const result = await proc.completed;
      stdout = result.stdout;
      exitCode = result.exitCode;

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
