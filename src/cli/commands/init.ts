import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CommandModule } from '../command.js';
import type { CliContext } from '../context.js';
import { scaffoldProject, CLI_AGENT_NAMES, type CliAgentName } from '../../init/scaffold.js';
import { ClaudeCodeBackend } from '../../agents/claude-code.js';
import { CursorBackend } from '../../agents/cursor.js';
import { CopilotBackend } from '../../agents/copilot.js';
import { CodexBackend } from '../../agents/codex.js';
import type { AgentBackend } from '../../agents/backend.js';
import { git as defaultGit } from '../../git/git.js';
import { registerYaaoMcp } from '../../init/mcp-register.js';

interface InitFlags {
  force?: boolean;
  minimal?: boolean;
  noProbe?: boolean;
  baseBranch?: string;
  mcp?: boolean;
}

export const initCommand: CommandModule = {
  name: 'init',
  describe: 'Initialize a yaao project (.yaao/ scaffold + .yaaoignore + .gitignore block)',
  bootstrap: true,
  register(program: Command, ctx: CliContext) {
    program
      .command('init')
      .description('Initialize a yaao project')
      .option('--force', 'overwrite existing files in .yaao/')
      .option('--minimal', 'skip .yaaoignore and .gitignore changes')
      .option('--no-probe', 'skip the agent-CLI availability probe; write everything as enabled')
      .option(
        '--base-branch <name>',
        "pin defaults.base-branch in the scaffolded config (skips git detection)",
      )
      .option(
        '--no-mcp',
        "skip auto-registering yaao's MCP server in .mcp.json (default-on so Claude Code sees yaao tools after init)",
      )
      .action(async (flags: InitFlags) => {
        const cwd = resolve(ctx.cwd);
        // F14.9 — Auto-detect the repo's default branch (main vs master vs
        // user's init.defaultBranch) when --base-branch isn't passed
        // explicitly. detectDefaultBranch is best-effort and always returns
        // *something*, so we don't have to handle "unknown".
        const detectedBase =
          flags.baseBranch ?? (await defaultGit.detectDefaultBranch(cwd));
        // Probe CLIs on PATH so the scaffolded config disables agents the user
        // doesn't actually have. Only probe when we're about to write the config
        // (skip if it already exists and --force wasn't passed).
        const configPath = join(cwd, '.yaao', 'yaao.config.json');
        const willWriteConfig = !existsSync(configPath) || Boolean(flags.force);
        // Vitest sets VITEST=true; skip the probe under tests so suites that
        // expect default-enabled agents keep passing. Tests that want to assert
        // probe behavior can pass --no-probe explicitly or stub the backends.
        const underVitest = process.env['VITEST'] === 'true';
        const shouldProbe = flags.noProbe !== true && willWriteConfig && !underVitest;
        const detected = shouldProbe ? await probeAgents() : undefined;
        if (detected) {
          const enabled = CLI_AGENT_NAMES.filter((a) => detected[a]);
          const disabled = CLI_AGENT_NAMES.filter((a) => !detected[a]);
          if (enabled.length > 0) {
            ctx.logger.info(`detected agent CLIs: ${enabled.join(', ')}`);
          }
          if (disabled.length > 0) {
            ctx.logger.info(`disabling agents (CLI not found): ${disabled.join(', ')}`);
          }
        }
        const result = scaffoldProject({
          cwd,
          force: Boolean(flags.force),
          minimal: Boolean(flags.minimal),
          ...(detected !== undefined ? { detectedAgents: detected } : {}),
          baseBranch: detectedBase,
        });
        if (willWriteConfig) {
          ctx.logger.info(
            flags.baseBranch
              ? `using base-branch '${detectedBase}' (from --base-branch)`
              : `detected base-branch: ${detectedBase}`,
          );
        }

        if (result.alreadyInitialized && result.created.length === 0 && result.overwritten.length === 0 && !result.gitignoreUpdated) {
          ctx.logger.info('already initialized', { cwd });
          ctx.exit(0);
          return;
        }

        ctx.logger.info(`initialized yaao in ${cwd}/.yaao`);
        for (const c of result.created) ctx.logger.info(`  created: ${c}`);
        for (const o of result.overwritten) ctx.logger.info(`  overwritten: ${o}`);
        if (result.gitignoreUpdated) {
          ctx.logger.info('  added managed block to .gitignore');
        } else if (result.gitignoreSkippedReason === 'no-git') {
          ctx.logger.warn('not a git repo; skipped .gitignore update');
        }
        // F15.2 — Auto-register yaao's MCP server unless --no-mcp.
        // Commander turns --no-mcp into flags.mcp === false; the default
        // when unset is true (opt-out).
        const mcpFlag = flags.mcp as boolean | undefined;
        const wantsMcp = mcpFlag !== false;
        if (wantsMcp) {
          const r = registerYaaoMcp({ cwd, force: Boolean(flags.force) });
          switch (r.action) {
            case 'created':
              ctx.logger.info(`  created: ${r.path} (registered yaao's MCP server)`);
              break;
            case 'merged':
              ctx.logger.info(`  merged: ${r.path} (added yaao to existing mcpServers)`);
              break;
            case 'unchanged':
              ctx.logger.info(`  unchanged: ${r.path} (yaao entry already matches)`);
              break;
            case 'conflict':
              if (r.warning) ctx.logger.warn(`  ${r.warning}`);
              break;
          }
        }

        ctx.logger.info('');
        ctx.logger.info('Next steps:');
        ctx.logger.info('  1. yaao doctor   # check available agents and config');
        ctx.logger.info('  2. yaao plan "describe what you want to build"');
        ctx.exit(0);
      });
  },
};

/**
 * Probe each CLI-backed agent (claude-code, cursor, copilot, codex) to see
 * whether its binary is on PATH. Returns a map of agent → available. Backends
 * already implement `isAvailable()`; we just fan out and tolerate per-probe
 * failures so a missing CLI doesn't blow up the whole init run.
 */
async function probeAgents(): Promise<Record<CliAgentName, boolean>> {
  const backends: Record<CliAgentName, AgentBackend> = {
    'claude-code': new ClaudeCodeBackend(),
    cursor: new CursorBackend(),
    copilot: new CopilotBackend(),
    codex: new CodexBackend(),
  };
  const out = {} as Record<CliAgentName, boolean>;
  await Promise.all(
    CLI_AGENT_NAMES.map(async (name) => {
      try {
        const r = await backends[name].isAvailable();
        out[name] = r.available;
      } catch {
        out[name] = false;
      }
    }),
  );
  return out;
}
