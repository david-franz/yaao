import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { CommandModule } from '../command.js';
import type { CliContext } from '../context.js';
import { listRuns } from '../../git/journal.js';
import { signalRun } from '../../exec/signal-run.js';

/**
 * `yaao stop <run-id>` — sends SIGTERM to the runner process. The
 * runner's own SIGTERM handler (5a05f8c) takes care of stamping
 * `run:end status=cancelled` and tearing down agents cleanly.
 *
 * Out-of-process companion to the Ctrl-C path that's been there
 * forever — same outcome, just dispatchable from a second terminal or
 * any tool that knows the run id.
 */
export const stopCommand: CommandModule = {
  name: 'stop',
  describe: 'Stop a running yaao run by sending SIGTERM to its runner process',
  bootstrap: true,
  register(program: Command, ctx: CliContext) {
    program
      .command('stop')
      .description('Stop a running yaao run by sending SIGTERM to its runner process')
      .argument('[run-id]', 'run id to stop (defaults to the most recent running run)')
      .action(async (runIdArg: string | undefined) => {
        const cwd = resolve(ctx.cwd);
        const journalDir = join(cwd, '.yaao', 'runs');
        let runId = runIdArg;
        if (!runId) {
          // No id given — pick the most recent run that's still running.
          // listRuns is newest-first by startedAt.
          const runs = await listRuns(journalDir);
          const live = runs.find((r) => r.status === 'running');
          if (!live) {
            ctx.logger.error(
              'no running runs to stop. Pass an explicit run-id, or check `yaao status`.',
            );
            ctx.exit(2);
            return;
          }
          runId = live.runId;
        }

        const result = signalRun({ cwd, runId });
        if (ctx.json) {
          process.stdout.write(`${JSON.stringify({ runId, ...result })}\n`);
          ctx.exit(result.signaled ? 0 : 1);
          return;
        }
        if (result.signaled) {
          ctx.logger.info(
            `sent SIGTERM to ${runId} (pid ${result.pid}). The runner will stamp 'cancelled' in the journal and exit.`,
          );
          ctx.exit(0);
          return;
        }
        // Failure modes get a friendly hint pointing at the likely cause.
        switch (result.reason) {
          case 'no-pid-file':
            ctx.logger.error(
              `no runner.pid for ${runId} — either the run already finished, or it was started before pid tracking landed. Try \`yaao status ${runId}\`.`,
            );
            break;
          case 'pid-dead':
            ctx.logger.error(
              `runner for ${runId} (pid ${result.pid}) is no longer alive — the run likely crashed; \`yaao doctor\` will flag this as an orphaned run.`,
            );
            break;
          case 'kill-failed':
            ctx.logger.error(`failed to signal runner for ${runId}: ${result.hint ?? 'unknown'}`);
            break;
          default:
            ctx.logger.error(`stop failed: ${result.reason}`);
        }
        ctx.exit(1);
      });
  },
};
