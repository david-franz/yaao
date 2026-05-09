import type { Command } from 'commander';
import type { CommandModule } from '../command.js';
import type { CliContext } from '../context.js';
import { detectAgents } from '../../agents/detect.js';
import type { AgentName } from '../../config/types.js';

interface AgentsFlags {
  strict?: boolean;
}

export const agentsCommand: CommandModule = {
  name: 'agents',
  describe: 'List detected agent backends and their availability',
  register(program: Command, ctx: CliContext) {
    program
      .command('agents')
      .description('List detected agent backends and their availability')
      .option('--strict', 'exit non-zero if any enabled agent is unavailable')
      .action(async (flags: AgentsFlags) => {
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
            const versionPart = r.version ? `v${r.version}` : '-';
            const reasonPart = r.reason ? ` — ${r.reason}` : '';
            ctx.logger.info(`${marker} ${r.agent.padEnd(12)} ${versionPart}${reasonPart}`);
          }
        }

        if (flags.strict && rows.some((r) => !r.available)) {
          ctx.exit(1);
          return;
        }
        ctx.exit(0);
      });
  },
};
