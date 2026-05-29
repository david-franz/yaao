import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { CommandModule } from '../command.js';
import type { CliContext } from '../context.js';
import { listRuns, loadRun } from '../../git/journal.js';
import { renderStatusTable } from '../../tui/status-table.js';

interface StatusFlags {
  watch?: boolean;
  task?: string;
  last?: boolean;
}

export const statusCommand: CommandModule = {
  name: 'status',
  describe: 'Inspect a finished or in-flight run',
  bootstrap: true,
  register(program: Command, ctx: CliContext) {
    program
      .command('status')
      .description(
        "Inspect a finished or in-flight run. Prints the task table + per-task agent/branch/duration/status; --watch tails the journal until the run finishes, surfacing live state transitions. With no run-id, the most recent run is targeted.",
      )
      .argument('[run-id]', 'run id (defaults to the most recent)')
      .option('--watch', 'tail the journal until the run finishes')
      .option('--task <id>', "focus on a single task's output log")
      .option('--last', 'most recent run (default if no run-id)')
      .action(async (runId: string | undefined, flags: StatusFlags) => {
        const cwd = resolve(ctx.cwd);
        const journalDir = join(cwd, '.yaao', 'runs');
        const runs = await listRuns(journalDir);
        const target = runId ? runs.find((r) => r.runId === runId) : runs[0];
        if (!target) {
          ctx.logger.error(`no matching run found in ${journalDir}`);
          ctx.exit(2);
          return;
        }
        if (flags.task) {
          const logPath = join(journalDir, target.runId, flags.task, 'output.log');
          if (!existsSync(logPath)) {
            ctx.logger.error(`no output log for task '${flags.task}' in run ${target.runId}`);
            ctx.exit(2);
            return;
          }
          process.stdout.write(readFileSync(logPath, 'utf8'));
          ctx.exit(0);
          return;
        }

        if (ctx.json) {
          process.stdout.write(`${JSON.stringify(target, null, 2)}\n`);
          ctx.exit(0);
          return;
        }

        if (flags.watch && target.status === 'running') {
          await tailRun(ctx, target.runId, journalDir);
          ctx.exit(0);
          return;
        }
        process.stdout.write(`${renderStatusTable(target)}\n`);
        ctx.exit(0);
      });
  },
};

async function tailRun(ctx: CliContext, runId: string, journalDir: string): Promise<void> {
  // Poll the summary sidecar every 250ms; print a refreshed status table when state
  // changes. Exits when the run reaches a terminal status.
  let lastSerialized = '';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { summary } = await loadRun(runId, journalDir);
    const next = renderStatusTable(summary);
    if (next !== lastSerialized) {
      // Clear and re-render. The TUI here is intentionally simple: a full reprint
      // each time state changes. Good enough for piped logs; Ink can come later.
      process.stdout.write(`\x1b[2J\x1b[H${next}\n`);
      lastSerialized = next;
    }
    if (summary.status !== 'running') return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, 250));
  }
  // Touch unused parameter so lint doesn't complain in some configs.
  void ctx;
}
