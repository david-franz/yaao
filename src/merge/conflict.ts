import { execa } from 'execa';
import type { AgentBackend } from '../agents/backend.js';
import type { ConflictContext, ConflictDecision, ConflictResolver } from './orchestrator.js';

export interface AgentResolverOptions {
  backend: AgentBackend;
  /** Maximum lines the resolver may change. Default 200. */
  maxLines?: number;
  /** Optional shell command to validate the resolution before committing. */
  validationCommand?: string;
}

/**
 * Conflict resolver that delegates to an agent backend. The agent runs in the merge
 * cwd (the user's main worktree, since the merge is happening there), is given the
 * conflict file list, and the resolution is rejected if `git diff --check` reports
 * leftover markers, the line ceiling is exceeded, or validation fails.
 */
export class AgentConflictResolver implements ConflictResolver {
  constructor(private readonly opts: AgentResolverOptions) {}

  async resolve(ctx: ConflictContext): Promise<ConflictDecision> {
    const prompt = buildResolverPrompt(ctx);
    const proc = await this.opts.backend.spawn({ cwd: ctx.worktreeRoot, prompt });
    // Drain events to keep the loop alive.
    void (async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of proc.events) { /* drain */ }
    })();
    try {
      await proc.completed;
    } catch (err) {
      return {
        resolved: false,
        mode: 'agent',
        reason: `agent failed: ${(err as Error).message}`,
      };
    }

    // Verify no leftover markers
    const check = await execa('git', ['diff', '--check'], { cwd: ctx.worktreeRoot, reject: false });
    if (typeof check.exitCode !== 'number' || check.exitCode !== 0) {
      return {
        resolved: false,
        mode: 'agent',
        reason: `git diff --check found leftover conflict markers: ${check.stdout?.toString() ?? ''}`,
      };
    }

    // Enforce line ceiling on the resolution
    const max = this.opts.maxLines ?? 200;
    const numstat = await execa('git', ['diff', '--cached', '--numstat'], {
      cwd: ctx.worktreeRoot,
      reject: false,
    });
    const lines = countLinesChanged(numstat.stdout?.toString() ?? '');
    if (lines > max) {
      return {
        resolved: false,
        mode: 'agent',
        reason: `agent resolution changed ${lines} lines (limit ${max})`,
      };
    }

    // Optional validation
    if (this.opts.validationCommand) {
      const v = await execa('sh', ['-c', this.opts.validationCommand], {
        cwd: ctx.worktreeRoot,
        reject: false,
      });
      if (typeof v.exitCode !== 'number' || v.exitCode !== 0) {
        return {
          resolved: false,
          mode: 'agent',
          reason: `validation '${this.opts.validationCommand}' failed (exit ${v.exitCode})`,
        };
      }
    }

    return {
      resolved: true,
      mode: 'agent',
      commitMessage: `[merge-resolve] ${ctx.task.id} into ${ctx.task.branch || 'base'} (${this.opts.backend.name})`,
    };
  }
}

export function buildResolverPrompt(ctx: ConflictContext): string {
  return [
    `You are resolving a git merge conflict in branch ${ctx.branch}.`,
    '',
    'Files in conflict:',
    ...ctx.files.map((f) => `  - ${f}`),
    '',
    'Edit only those files to remove the `<<<<<<<`, `=======`, `>>>>>>>` markers and produce a coherent merged result.',
    'Do not modify any other files. Run `git diff --check` to verify your work.',
  ].join('\n');
}

function countLinesChanged(numstat: string): number {
  let total = 0;
  for (const line of numstat.split(/\r?\n/)) {
    if (!line) continue;
    const [insStr, delStr] = line.split('\t');
    const ins = Number(insStr ?? '0');
    const del = Number(delStr ?? '0');
    if (Number.isFinite(ins)) total += ins;
    if (Number.isFinite(del)) total += del;
  }
  return total;
}
