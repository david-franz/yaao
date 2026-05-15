import { rmSync, readdirSync, statSync } from 'node:fs';
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
      .description('Tear down worktrees and branches')
      .argument('[run-id]', 'run id; omit with --all to clean every finished run')
      .option('--all', 'clean every finished run')
      .option('--worktrees-only', 'only remove worktrees (leave branches)')
      .option('--branches-only', 'only remove branches (leave worktrees)')
      .option('--keep-failed', 'do not touch worktrees from failed/cancelled runs (default true)')
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

        const keepFailed = flags.keepFailed !== false; // default true
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
            // eslint-disable-next-line no-await-in-loop -- per-run cleanup is sequential
            const removed = await wtManager.pruneOrphans(new Set([])); // remove all known stamps
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
        }

        if (flags.runs) {
          const days = Number(flags.runs);
          if (Number.isFinite(days) && days >= 0) {
            const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
            for (const f of readdirSync(journalDir)) {
              if (!f.endsWith('.jsonl') && !f.endsWith('.summary.json')) continue;
              const full = join(journalDir, f);
              try {
                if (statSync(full).mtimeMs < cutoff) {
                  rmSync(full);
                  if (f.endsWith('.jsonl')) summary.journalsRemoved += 1;
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
