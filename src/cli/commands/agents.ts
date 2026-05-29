import type { Command } from 'commander';
import type { CommandModule } from '../command.js';
import type { CliContext } from '../context.js';
import { detectAgents } from '../../agents/detect.js';
import type { AgentName } from '../../config/types.js';
import { isAgentEnabled } from '../../config/enabled-agents.js';
import { listKnownModels } from '../../agents/known-models.js';

interface AgentsFlags {
  strict?: boolean;
  models?: boolean;
  agent?: string;
}

export const agentsCommand: CommandModule = {
  name: 'agents',
  describe: 'List detected agent backends and their availability',
  register(program: Command, ctx: CliContext) {
    program
      .command('agents')
      .description('List detected agent backends and their availability')
      .option('--strict', 'exit non-zero if any enabled agent is unavailable')
      .option(
        '--models',
        "list the known-models catalog per backend (advisory; passing models not in the catalog still works if the vendor accepts them)",
      )
      .option('--agent <name>', 'filter --models output to a single backend')
      .action(async (flags: AgentsFlags) => {
        if (flags.models) {
          const filter = flags.agent
            ? { agent: flags.agent as AgentName }
            : undefined;
          const rows = listKnownModels(filter);
          if (ctx.json) {
            process.stdout.write(`${JSON.stringify({ catalog: rows }, null, 2)}\n`);
          } else {
            for (const row of rows) {
              ctx.logger.info(`${row.label} (catalog as of ${row.asOf}):`);
              for (const m of row.models) {
                const alias = m.alias ? ` (alias: ${m.alias})` : '';
                const notes = m.notes ? `  — ${m.notes}` : '';
                ctx.logger.info(`  ${m.name}${alias}${notes}`);
              }
              ctx.logger.info('');
            }
          }
          ctx.exit(0);
          return;
        }

        const availability = await detectAgents(ctx.config);
        type Row = { agent: AgentName; available: boolean; version?: string; reason?: string };
        const rows: Row[] = [];
        for (const [agent, report] of availability.byName) {
          rows.push({
            agent,
            available: report.available,
            ...(report.version !== undefined ? { version: report.version } : {}),
            ...(report.reason !== undefined ? { reason: report.reason } : {}),
          });
        }
        rows.sort((a, b) => (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0));

        if (ctx.json) {
          process.stdout.write(`${JSON.stringify({ agents: rows }, null, 2)}\n`);
        } else {
          for (const r of rows) {
            const marker = r.available ? '✔' : '✘';
            const versionPart = r.version ? `v${r.version}` : '';
            const reasonPart = r.reason ? `— ${r.reason}` : '';
            // Render: `✔ claude-code v1.2.3` or `✘ codex — binary 'codex' not found on PATH`.
            // Pad the agent column so versions/reasons line up across rows.
            const tail = [versionPart, reasonPart].filter(Boolean).join(' ');
            ctx.logger.info(`${marker} ${r.agent.padEnd(12)} ${tail}`.trimEnd());
          }
        }

        // `--strict` only fails on agents that are *enabled* in yaao.config.json.
        // An unconfigured backend (e.g. `api` with no provider keys) is not enabled
        // and should not block the check.
        if (flags.strict) {
          const enabledUnavailable = rows.filter(
            (r) => !r.available && isAgentEnabled(ctx.config, r.agent),
          );
          if (enabledUnavailable.length > 0) {
            ctx.exit(1);
            return;
          }
        }
        ctx.exit(0);
      });
  },
};
