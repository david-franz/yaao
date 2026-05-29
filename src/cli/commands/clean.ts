import { rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { CommandModule } from '../command.js';
import type { CliContext } from '../context.js';
import { listRuns, type RunSummary } from '../../git/journal.js';
import { WorktreeManager } from '../../git/worktree-manager.js';
import { git } from '../../git/git.js';

interface CleanFlags {
  all?: boolean;
  worktreesOnly?: boolean;
  branchesOnly?: boolean;
  keepFailed?: boolean;
  force?: boolean;
  runs?: string;
}

export const cleanCommand: CommandModule = {
  name: 'clean',
  describe: 'Tear down worktrees and branches from a previous run',
  register(program: Command, ctx: CliContext) {
    program
      .command('clean')
      .description(
        "Tear down worktrees and (optionally) task branches for a finished run. Refuses to clean unmerged work without --force; safer programmatic alternative is the `yaao_prune` MCP tool with dry-run preview.",
      )
      .argument('[run-id]', 'run id; omit with --all to clean every finished run')
      .option('--all', 'clean every finished run')
      .option('--worktrees-only', 'only remove worktrees (leave branches)')
      .option('--branches-only', 'only remove branches (leave worktrees)')
      .option('--keep-failed', 'with --all, skip failed/cancelled runs (so they remain resumable)')
      .option('--force', 'override the unmerged-work safety net')
      .option('--runs <days>', 'also prune journals older than N days')
      .action(async (runId: string | undefined, flags: CleanFlags) => {
        const cwd = resolve(ctx.cwd);
        const journalDir = join(cwd, '.yaao', 'runs');
        const summaries = await listRuns(journalDir);
        if (summaries.length === 0) {
          ctx.logger.info('no runs found');
          ctx.exit(0);
          return;
        }
        const targets = pickTargets(summaries, runId, Boolean(flags.all));
        if (targets.length === 0) {
          ctx.logger.error('no matching run; pass --all or a specific run id');
          ctx.exit(2);
          return;
        }

        // An explicit run-id is treated as explicit consent: clean it even if
        // it failed/cancelled. The --keep-failed flag only fences off failed
        // runs in --all mode, where the user hasn't named the run.
        const explicitRunId = runId !== undefined && !flags.all;
        const keepFailed = !explicitRunId && Boolean(flags.keepFailed);
        const removeWorktrees = !flags.branchesOnly;
        const removeBranches = !flags.worktreesOnly;
        const summary = { worktreesRemoved: 0, branchesRemoved: 0, journalsRemoved: 0 };

        for (const target of targets) {
          if (keepFailed && (target.status === 'failed' || target.status === 'cancelled')) {
            ctx.logger.info(`keeping failed/cancelled run ${target.runId}`);
            continue;
          }
          // Refuse to touch unmerged worktrees unless --force.
          const unmerged = Object.entries(target.tasks).filter(
            ([, t]) => t.status === 'completed' && !t.branch?.endsWith('/merged'),
          );
          if (unmerged.length > 0 && !flags.force && removeWorktrees) {
            ctx.logger.warn(
              `run ${target.runId} has ${unmerged.length} unmerged completed task(s); pass --force to clean anyway`,
            );
            continue;
          }

          const wtManager = new WorktreeManager({
            git,
            rootDir: cwd,
            worktreeRoot: '.yaao/worktrees',
          });
          if (removeWorktrees) {
            // Keep every other run's worktrees intact so a targeted clean
            // doesn't nuke unrelated runs. Only the target run's stamped
            // worktrees fall outside this active set and get pruned.
            const active = new Set(summaries.map((s) => s.runId).filter((id) => id !== target.runId));
            // eslint-disable-next-line no-await-in-loop -- per-run cleanup is sequential
            const removed = await wtManager.pruneOrphans(active);
            summary.worktreesRemoved += removed.length;
          }
          if (removeBranches) {
            // Per-task branch deletion. Branches that don't exist are silently skipped.
            for (const [, t] of Object.entries(target.tasks)) {
              const branch = t.branch;
              if (!branch) continue;
              try {
                // eslint-disable-next-line no-await-in-loop -- per-branch sequential
                await git.deleteBranch(branch, { force: true }, cwd);
                summary.branchesRemoved += 1;
              } catch {
                // ignore — branch may already be deleted or not exist
              }
            }
          }
          // Wipe the per-run directory under .yaao/runs/<run-id>/ — this is
          // where the journal, summary, per-task output.log, and context.md
          // live. Doing it here means a `yaao clean <run-id>` (or `--all`) is
          // sufficient on its own; subsequent runs of the same plan do NOT
          // need `yaao run --force` to clear leftover state.
          if (!flags.branchesOnly && !flags.worktreesOnly) {
            const runPath = join(journalDir, target.runId);
            try {
              if (existsSync(runPath)) {
                rmSync(runPath, { recursive: true, force: true });
                summary.journalsRemoved += 1;
              }
            } catch {
              // ignore — best effort
            }
          }
        }

        if (flags.runs) {
          const days = Number(flags.runs);
          if (Number.isFinite(days) && days >= 0) {
            const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
            for (const entry of readdirSync(journalDir)) {
              const runPath = join(journalDir, entry);
              const summaryPath = join(runPath, 'summary.json');
              if (!existsSync(summaryPath)) continue;
              try {
                if (statSync(summaryPath).mtimeMs < cutoff) {
                  rmSync(runPath, { recursive: true, force: true });
                  summary.journalsRemoved += 1;
                }
              } catch {
                // ignore
              }
            }
          }
        }

        if (ctx.json) {
          process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
        } else {
          ctx.logger.info(
            `cleaned: ${summary.worktreesRemoved} worktree(s), ${summary.branchesRemoved} branch(es), ${summary.journalsRemoved} journal(s)`,
          );
        }
        ctx.exit(0);
        // Touch unused flag so lint doesn't complain — flag exists by spec.
        if (flags.worktreesOnly && flags.branchesOnly) {
          ctx.logger.warn('--worktrees-only and --branches-only are both set; nothing to clean');
        }
        return;

        function pickTargets(all: RunSummary[], id: string | undefined, every: boolean): RunSummary[] {
          if (every) return all;
          if (id) return all.filter((r) => r.runId === id);
          // Default to the most recent successful run.
          const last = all.find((r) => r.status === 'success');
          return last ? [last] : [];
        }
      });
  },
};
