import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { CommandModule } from '../command.js';
import type { CliContext } from '../context.js';
import { runPlanner, type ProgressEvent } from '../../planner/run.js';
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
        const isTty = process.stderr.isTTY === true;
        const isDryRun = Boolean(flags.dryRun);
        const reporter = !ctx.json && !isDryRun ? makeProgressReporter(isTty) : undefined;
        const result = await runPlanner({
          cwd,
          config: ctx.config,
          description,
          ...(flags.scope !== undefined ? { scope: flags.scope } : {}),
          ...(flags.format !== undefined ? { format: flags.format } : {}),
          ...(flags.out !== undefined ? { outDir: flags.out } : {}),
          ...(flags.dryRun !== undefined ? { dryRun: flags.dryRun } : {}),
          backend,
          ...(reporter !== undefined ? { onProgress: reporter } : {}),
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

/**
 * Streams agent progress to stderr so the user knows yaao isn't hung. On a TTY we
 * use a carriage-return-only ticker so the elapsed-time line stays on a single row;
 * piped output gets one line per tick. Tool-use events get a short caption; text
 * chunks from the agent (e.g. its reasoning) are forwarded as-is.
 */
function makeProgressReporter(isTty: boolean): (ev: ProgressEvent) => void {
  let lastTickLen = 0;
  const clearTick = () => {
    if (!isTty || lastTickLen === 0) return;
    process.stderr.write(`\r${' '.repeat(lastTickLen)}\r`);
    lastTickLen = 0;
  };
  const write = (s: string) => {
    clearTick();
    process.stderr.write(s);
  };
  return (ev) => {
    if (ev.type === 'spawn') {
      write(`yaao plan: spawning ${ev.agent}...\n`);
      return;
    }
    if (ev.type === 'tick') {
      const s = Math.floor(ev.elapsedMs / 1000);
      const m = Math.floor(s / 60);
      const stamp = m > 0 ? `${m}m${(s % 60).toString().padStart(2, '0')}s` : `${s}s`;
      const line = `\rworking... (${stamp})`;
      if (isTty) {
        process.stderr.write(line);
        lastTickLen = line.length - 1; // ignore the leading \r in clear width
      } else if (s > 0 && s % 5 === 0) {
        // Non-TTY: emit one line every 5s so users tailing logs see something.
        process.stderr.write(`${line.trim()}\n`);
      }
      return;
    }
    if (ev.type === 'agent') {
      const e = ev.event;
      if (e.type === 'tool-use') {
        try {
          const parsed = JSON.parse(e.data) as { name?: string };
          write(`  → tool: ${parsed.name ?? '?'}\n`);
        } catch {
          write(`  → tool: (raw)\n`);
        }
      } else if (e.type === 'thinking') {
        write(`  · thinking (${e.data.length} chars)\n`);
      } else if (e.type === 'stdout') {
        // Forward small text chunks; truncate long lines so the user still gets
        // a sense of progress without flooding the terminal.
        const trimmed = e.data.length > 200 ? `${e.data.slice(0, 200)}…` : e.data;
        write(trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`);
      }
      return;
    }
    if (ev.type === 'done') {
      clearTick();
      const s = Math.floor(ev.durationMs / 1000);
      const m = Math.floor(s / 60);
      const stamp = m > 0 ? `${m}m${(s % 60).toString().padStart(2, '0')}s` : `${s}s`;
      write(`yaao plan: done in ${stamp} (${ev.files.length} file(s))\n`);
    }
  };
}
