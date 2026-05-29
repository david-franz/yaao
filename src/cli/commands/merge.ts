import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { CommandModule } from '../command.js';
import type { CliContext } from '../context.js';
import { loadPlan } from '../../plan/yaml/loader.js';
import { runMerge, type MergeMode, type MergePolicy } from '../../merge/orchestrator.js';
import { planBranches } from '../../git/branch-graph.js';
import { listRuns } from '../../git/journal.js';

interface MergeFlags {
  target?: string;
  mode?: 'auto' | 'manual' | 'agent';
  dryRun?: boolean;
  pr?: boolean;
}

export const mergeCommand: CommandModule = {
  name: 'merge',
  describe: 'Merge completed task branches in topological order',
  register(program: Command, ctx: CliContext) {
    program
      .command('merge')
      .description(
        "Land a finished run's completed task branches onto a target (default: the plan's base-branch). Topologically ordered to minimise conflicts; auto / agent / manual conflict modes per the plan's merge config.",
      )
      .argument('[run-id]', 'run id (defaults to most recent finished run)')
      .option('--target <branch>', 'override base branch')
      .option('--mode <mode>', 'on-conflict mode: auto | manual | agent')
      .option('--dry-run', 'show the merge plan without touching git')
      .option('--pr', 'submit PRs for tasks (requires gh)')
      .action(async (runId: string | undefined, flags: MergeFlags) => {
        const cwd = resolve(ctx.cwd);
        const journalDir = join(cwd, '.yaao', 'runs');
        const runs = await listRuns(journalDir);
        const target = runId
          ? runs.find((r) => r.runId === runId)
          : runs.find((r) => r.status === 'success');
        if (!target) {
          ctx.logger.error(`no matching run found in ${journalDir}`);
          ctx.exit(2);
          return;
        }
        const planFile = existsSync(target.planFile)
          ? target.planFile
          : resolve(cwd, target.planFile);
        if (!existsSync(planFile)) {
          ctx.logger.error(`plan file referenced by the run is missing: ${target.planFile}`);
          ctx.exit(2);
          return;
        }
        const loaded = await loadPlan(planFile, { cwd, config: ctx.config });
        const branchPlan = planBranches(loaded.plan);
        const baseBranch = flags.target ?? loaded.plan.config['base-branch'];
        const completed = Object.entries(target.tasks)
          .filter(([, t]) => t.status === 'completed')
          .map(([id]) => id);

        const policy: MergePolicy = {
          onConflict: ((flags.mode ?? loaded.plan.config.merge['on-conflict']) as MergeMode | undefined) ?? 'manual',
        };

        if (flags.dryRun) {
          if (ctx.json) {
            process.stdout.write(
              `${JSON.stringify({ runId: target.runId, baseBranch, completed, policy }, null, 2)}\n`,
            );
          } else {
            ctx.logger.info(`would merge run ${target.runId} into ${baseBranch}`);
            for (const id of completed) ctx.logger.info(`  - ${id}`);
          }
          ctx.exit(0);
          return;
        }

        // PR submitter wiring is intentionally minimal here; tests inject their own.
        const out = await runMerge({
          runId: target.runId,
          plan: loaded.plan,
          branchPlan,
          baseBranch,
          rootDir: cwd,
          policy,
          completedTaskIds: completed,
        });

        if (ctx.json) {
          process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
        } else {
          ctx.logger.info(
            `merged ${out.merged.length} task(s) into ${baseBranch}; ${out.conflicts.length} conflict(s); ${out.skipped.length} skipped`,
          );
          for (const m of out.merged) ctx.logger.info(`  ✔ merged: ${m}`);
          for (const c of out.conflicts) ctx.logger.info(`  ✘ conflict: ${c.taskId} (${c.mode})`);
          for (const s of out.skipped) ctx.logger.info(`  · skipped: ${s.taskId} (${s.reason})`);
        }
        ctx.exit(out.conflicts.length > 0 ? 1 : 0);
        // Acknowledge the unused flag — wired in F6.3 path; surface warning if user asked
        // for PR mode without a configured submitter so this command isn't silent.
        if (flags.pr) {
          ctx.logger.warn('--pr requires GhPrSubmitter wiring; reconfigure tasks with `merge: pr` and re-run.');
        }
      });
  },
};
