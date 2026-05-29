import type { Command } from 'commander';
import type { CommandModule } from '../command.js';
import type { CliContext } from '../context.js';
import { detectAgents } from '../../agents/detect.js';
import type { AgentName } from '../../config/types.js';
import { isAgentEnabled } from '../../config/enabled-agents.js';

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
            const versionPart = r.version ? `v${r.version}` : '';
            const reasonPart = r.reason ? `— ${r.reason}` : '';
            // Render: `✔ claude-code v1.2.3` or `✘ codex          — codex --version exited -1`
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
