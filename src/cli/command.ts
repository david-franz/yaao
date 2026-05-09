import type { Command } from 'commander';
import type { CliContext } from './context.js';

export interface CommandModule {
  name: string;
  describe: string;
  register(program: Command, ctx: CliContext): void;
}

export interface StubOptions {
  name: string;
  describe: string;
  phase: string;
  args?: { name: string; required?: boolean }[];
}

/**
 * Builds a stub command module that prints a "not yet implemented" message and exits 2.
 * Used by every command whose real implementation lands in a later phase.
 */
export function makeStubCommand(opts: StubOptions): CommandModule {
  return {
    name: opts.name,
    describe: opts.describe,
    register(program, ctx) {
      const cmd = program.command(opts.name).description(opts.describe);
      if (opts.args) {
        for (const a of opts.args) {
          cmd.argument(a.required === false ? `[${a.name}]` : `<${a.name}>`);
        }
      }
      cmd.action(() => {
        ctx.logger.error(
          `not yet implemented (will land in phase ${opts.phase})`,
          { command: opts.name },
        );
        ctx.exit(2);
      });
    },
  };
}
