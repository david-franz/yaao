import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { CommandModule } from '../command.js';
import type { CliContext } from '../context.js';
import { runPlanner } from '../../planner/run.js';
import type { PlanScope } from '../../planner/scope.js';
import { ClaudeCodeBackend } from '../../agents/claude-code.js';
import { CursorBackend } from '../../agents/cursor.js';
import { CopilotBackend } from '../../agents/copilot.js';
import { CodexBackend } from '../../agents/codex.js';
import type { AgentBackend, AgentName } from '../../agents/backend.js';

interface PlanFlags {
  scope?: PlanScope;
  format?: 'markdown' | 'speckit' | 'both';
  agent?: AgentName;
  model?: string;
  out?: string;
  noCtxSys?: boolean;
  dryRun?: boolean;
  nonInteractive?: boolean;
}

export const planCommand: CommandModule = {
  name: 'plan',
  describe: 'Generate an implementation plan from a description',
  register(program: Command, ctx: CliContext) {
    program
      .command('plan')
      .description('Generate an implementation plan')
      .argument('<description>', 'what to plan')
      .option('--scope <scope>', 'feature | project (auto-detected by default)')
      .option('--format <format>', 'markdown | speckit | both')
      .option('--agent <name>', 'agent to drive the planner skill')
      .option('--model <name>', 'model to pass to the agent')
      .option('--out <path>', 'output directory (default .yaao/plans)')
      .option('--no-ctx-sys', 'disable ctx-sys auto-spawn for this run')
      .option('--dry-run', 'print the resolved prompt and exit (no agent spawn)')
      .option('--non-interactive', 'never prompt for confirmation')
      .action(async (description: string, flags: PlanFlags) => {
        const cwd = resolve(ctx.cwd);
        const agentName = flags.agent ?? ctx.config.defaults.agent;
        const backend = backendFor(agentName);
        const result = await runPlanner({
          cwd,
          config: ctx.config,
          description,
          ...(flags.scope !== undefined ? { scope: flags.scope } : {}),
          ...(flags.format !== undefined ? { format: flags.format } : {}),
          ...(flags.out !== undefined ? { outDir: flags.out } : {}),
          ...(flags.dryRun !== undefined ? { dryRun: flags.dryRun } : {}),
          backend,
        });
        if (ctx.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else if (flags.dryRun) {
          ctx.logger.info(`scope: ${result.scope}, format: ${result.format}`);
          ctx.logger.info('--- resolved prompt ---');
          process.stdout.write(result.prompt);
          process.stdout.write('\n');
        } else {
          if (result.files.length === 0) {
            ctx.logger.warn('planner did not produce any files in the output directory');
          } else {
            for (const f of result.files) ctx.logger.info(`  wrote: ${f}`);
            if (result.plan) {
              ctx.logger.info(`tasks: ${result.plan.tasks.length}`);
              for (const issue of result.issues) ctx.logger.warn(`  ${issue.code}: ${issue.message}`);
            }
          }
        }
        ctx.exit(result.ok ? 0 : 1);
      });
  },
};

export function backendFor(agent: AgentName): AgentBackend {
  switch (agent) {
    case 'claude-code':
      return new ClaudeCodeBackend();
    case 'cursor':
      return new CursorBackend();
    case 'copilot':
      return new CopilotBackend();
    case 'codex':
      return new CodexBackend();
    case 'api':
      throw new Error('the `api` backend is not supported by yaao plan in MVP; use a CLI agent');
  }
}
