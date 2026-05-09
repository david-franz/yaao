import type { Command } from 'commander';
import type { CommandModule } from '../command.js';
import type { CliContext } from '../context.js';

/**
 * F1.2: stub. F1.4 replaces the action with the real scaffolder.
 */
export const initCommand: CommandModule = {
  name: 'init',
  describe: 'Initialize a yaao project (.yaao/ scaffold + .yaaoignore + .gitignore block)',
  register(program: Command, ctx: CliContext) {
    program
      .command('init')
      .description('Initialize a yaao project')
      .option('--force', 'overwrite existing files in .yaao/')
      .option('--minimal', 'skip .yaaoignore and .gitignore changes')
      .action(() => {
        ctx.logger.error('not yet implemented (will land in phase F1.4)', { command: 'init' });
        ctx.exit(2);
      });
  },
};
