import type { Command } from 'commander';
import { resolve } from 'node:path';
import type { CommandModule } from '../command.js';
import type { CliContext } from '../context.js';
import { scaffoldProject } from '../../init/scaffold.js';

interface InitFlags {
  force?: boolean;
  minimal?: boolean;
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
      .action((flags: InitFlags) => {
        const cwd = resolve(ctx.cwd);
        const result = scaffoldProject({
          cwd,
          force: Boolean(flags.force),
          minimal: Boolean(flags.minimal),
        });

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
        ctx.logger.info('');
        ctx.logger.info('Next steps:');
        ctx.logger.info('  1. yaao doctor   # check available agents and config');
        ctx.logger.info('  2. yaao plan "describe what you want to build"');
        ctx.exit(0);
      });
  },
};
