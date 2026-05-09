import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { CommandModule } from '../command.js';
import type { CliContext } from '../context.js';
import { loadPlan } from '../../plan/yaml/loader.js';
import { runPlan } from '../../exec/runner.js';
import type { RunOptions } from '../../exec/runner.js';
import type { ResolvedTask } from '../../plan/schema/types.js';
import type { AgentBackend, AgentName } from '../../agents/backend.js';
import { ClaudeCodeBackend } from '../../agents/claude-code.js';
import { CursorBackend } from '../../agents/cursor.js';
import { CopilotBackend } from '../../agents/copilot.js';
import { CodexBackend } from '../../agents/codex.js';
import { ApiBackend, AnthropicProvider, OpenAIProvider, OpenRouterProvider } from '../../agents/api/backend.js';
import type { ApiProvider } from '../../agents/api/provider.js';
import type { YaaoConfig } from '../../config/types.js';
import type { ResolvedPlan } from '../../plan/schema/types.js';

interface RunFlags {
  maxParallel?: string;
  baseBranch?: string;
  dryRun?: boolean;
  trial?: boolean;
  noTui?: boolean;
  only?: string;
  skip?: string;
  resume?: string;
  force?: boolean;
}

export const runCommand: CommandModule = {
  name: 'run',
  describe: 'Execute a plan across worktrees',
  register(program: Command, ctx: CliContext) {
    program
      .command('run')
      .description('Execute a plan across worktrees')
      .argument('<exec-plan>', 'plan file (YAML)')
      .option('--max-parallel <n>', 'override plan.config.max-parallel')
      .option('--base-branch <name>', 'override plan.config.base-branch')
      .option('--dry-run', 'walk the DAG without spawning agents')
      .option('--trial', 'max-parallel 1, no merging — for plan debugging')
      .option('--no-tui', 'plain line-oriented logs (no live dashboard)')
      .option('--only <ids>', 'comma-separated task ids to include (with deps)')
      .option('--skip <ids>', 'comma-separated task ids to skip (with downstream)')
      .option('--resume <run-id>', 'resume a prior run; checks plan-hash')
      .option('--force', 'accept blocking conditions (plan-hash mismatch on resume)')
      .action(async (planPath: string, flags: RunFlags) => {
        if (flags.only && flags.skip) {
          ctx.logger.error('--only and --skip are mutually exclusive');
          ctx.exit(1);
          return;
        }
        if (flags.dryRun && flags.trial) {
          ctx.logger.error('--dry-run and --trial are mutually exclusive');
          ctx.exit(1);
          return;
        }
        const cwd = resolve(ctx.cwd);
        const planFile = resolve(cwd, planPath);
        if (!existsSync(planFile)) {
          ctx.logger.error(`plan not found: ${planFile}`);
          ctx.exit(2);
          return;
        }
        const loaded = await loadPlan(planFile, { cwd, config: ctx.config });

        // Apply CLI overrides on the resolved plan in-place (cheap; resolved plans aren't shared).
        if (flags.maxParallel) {
          const n = Number(flags.maxParallel);
          if (Number.isFinite(n) && n > 0) loaded.plan.config['max-parallel'] = n;
        }
        if (flags.baseBranch) {
          loaded.plan.config['base-branch'] = flags.baseBranch;
        }

        const filter = buildFilter(flags);

        if (flags.dryRun) {
          await emitDryRun(ctx, loaded.plan, filter);
          ctx.exit(0);
          return;
        }

        const runId = flags.resume ?? `run-${Date.now().toString(36)}`;
        const opts: RunOptions = {
          runId,
          plan: loaded.plan,
          planFile,
          rootDir: cwd,
          config: ctx.config,
          backendFor: (task: ResolvedTask): AgentBackend =>
            backendForTask(task, ctx.config),
        };
        if (filter !== undefined) opts.filter = filter;
        if (flags.trial) opts.trial = true;

        const result = await runPlan(opts);
        if (ctx.json) {
          process.stdout.write(`${JSON.stringify({ runId, status: result.status, durationMs: result.durationMs })}\n`);
        } else {
          ctx.logger.info(`run ${runId} ${result.status} in ${result.durationMs}ms`);
        }
        ctx.exit(result.status === 'success' ? 0 : 1);
      });
  },
};

function buildFilter(flags: RunFlags): { only?: string[]; skip?: string[] } | undefined {
  const splitCsv = (v: string | undefined): string[] | undefined =>
    v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const only = splitCsv(flags.only);
  const skip = splitCsv(flags.skip);
  if (!only && !skip) return undefined;
  const out: { only?: string[]; skip?: string[] } = {};
  if (only) out.only = only;
  if (skip) out.skip = skip;
  return out;
}

function backendForTask(task: ResolvedTask, config: YaaoConfig): AgentBackend {
  const a = config.agents as unknown as Record<string, { bin?: string } | undefined>;
  switch (task.agent as AgentName) {
    case 'claude-code':
      return new ClaudeCodeBackend({ bin: a['claude-code']?.bin });
    case 'cursor':
      return new CursorBackend({ bin: a['cursor']?.bin });
    case 'copilot':
      return new CopilotBackend({ bin: a['copilot']?.bin });
    case 'codex':
      return new CodexBackend({ bin: a['codex']?.bin });
    case 'api': {
      const providerName = task.api?.provider ?? 'anthropic';
      const provider: ApiProvider =
        providerName === 'anthropic'
          ? new AnthropicProvider()
          : providerName === 'openai'
            ? new OpenAIProvider()
            : new OpenRouterProvider();
      const key = config.agents.api.providers[providerName]?.['api-key'];
      const baseUrl = task.api?.['base-url'] ?? config.agents.api.providers[providerName]?.['base-url'];
      return new ApiBackend({
        provider,
        ...(key !== undefined ? { apiKey: key } : {}),
        ...(baseUrl !== undefined ? { baseUrl } : {}),
      });
    }
  }
}

async function emitDryRun(
  ctx: CliContext,
  plan: ResolvedPlan,
  filter: { only?: string[]; skip?: string[] } | undefined,
): Promise<void> {
  const { Scheduler } = await import('../../exec/scheduler.js');
  const scheduler = new Scheduler({
    plan,
    ...(filter !== undefined ? { filter } : {}),
    maxParallel: plan.config['max-parallel'],
  });
  // Simulate completion to compute layer order.
  const layers: string[][] = [];
  while (!scheduler.done()) {
    const ready = scheduler.readyTasks();
    if (ready.length === 0) break;
    layers.push(ready);
    for (const id of ready) {
      scheduler.startTask(id);
      scheduler.completeTask(id, {});
    }
  }
  const snapshot = scheduler.snapshot();
  if (ctx.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          plan: plan.plan.name,
          tasks: plan.tasks.length,
          maxParallel: plan.config['max-parallel'],
          layers,
          snapshot,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  ctx.logger.info(`plan: ${plan.plan.name}    tasks: ${plan.tasks.length}    max-parallel: ${plan.config['max-parallel']}`);
  layers.forEach((layer, i) => {
    ctx.logger.info(`  layer ${i + 1} [${layer.length}]:  ${layer.join(', ')}`);
  });
  for (const [id, status] of Object.entries(snapshot)) {
    if (status === 'skipped') ctx.logger.info(`  skipped: ${id}`);
  }
}
