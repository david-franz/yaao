import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { CommandModule } from '../command.js';
import type { CliContext } from '../context.js';
import { convertPlan } from '../../converter/convert.js';
import type { PlanInputFormat } from '../../converter/load-plan.js';
import type { InferMode } from '../../converter/infer-deps.js';

interface ConvertFlags {
  out?: string;
  from?: PlanInputFormat;
  inferDeps?: InferMode;
}

export const convertCommand: CommandModule = {
  name: 'convert',
  describe: 'Convert an implementation plan into an execution plan (YAML)',
  register(program: Command, ctx: CliContext) {
    program
      .command('convert')
      .description('Convert an implementation plan into an execution plan')
      .argument('<plan>', 'plan file (markdown) or directory (Spec Kit triplet)')
      .option('--out <path>', 'output path (default .yaao/exec/<slug>.yaml)')
      .option('--from <format>', 'markdown | speckit | auto', 'auto')
      .option('--infer-deps <mode>', 'off | suggest | auto', 'off')
      .action(async (input: string, flags: ConvertFlags) => {
        const cwd = resolve(ctx.cwd);
        const result = await convertPlan({
          cwd,
          config: ctx.config,
          input,
          ...(flags.out !== undefined ? { out: flags.out } : {}),
          ...(flags.from !== undefined ? { format: flags.from } : {}),
          ...(flags.inferDeps !== undefined ? { infer: flags.inferDeps } : {}),
        });
        if (ctx.json) {
          process.stdout.write(
            `${JSON.stringify(
              {
                outPath: result.outPath,
                tasks: result.plan.tasks.length,
                warnings: result.warnings,
                inferred: result.inferred,
              },
              null,
              2,
            )}\n`,
          );
        } else {
          ctx.logger.info(`✔ wrote ${result.outPath}`);
          ctx.logger.info(`  tasks: ${result.plan.tasks.length}`);
          for (const w of result.warnings) ctx.logger.warn(`  ${w}`);
          if (result.inferred.length > 0) {
            ctx.logger.info(`  inferred dependencies: ${result.inferred.length}`);
          }
          ctx.logger.info('');
          ctx.logger.info(`next: yaao validate ${result.outPath} && yaao run ${result.outPath}`);
        }
        ctx.exit(0);
      });
  },
};
