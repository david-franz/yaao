import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { CommandModule } from '../command.js';
import type { CliContext } from '../context.js';
import { convertPlans } from '../../converter/convert.js';
import type { PlanInputFormat } from '../../converter/load-plan.js';
import type { InferMode } from '../../converter/infer-deps.js';

interface ConvertFlags {
  out?: string;
  from?: PlanInputFormat;
  inferDeps?: InferMode;
  featureBranch?: string;
}

export const convertCommand: CommandModule = {
  name: 'convert',
  describe: 'Convert one or many implementation plans into execution YAMLs',
  register(program: Command, ctx: CliContext) {
    program
      .command('convert')
      .description(
        "Convert an implementation plan (or a directory of plans, recursively) into execution YAML. --from auto picks markdown vs speckit per-plan from the file shape (single .md → markdown; spec.md+plan.md+tasks.md → speckit). Output lands in `plan.exec-dir` (default .yaao/exec) unless --out is passed.",
      )
      .argument(
        '[plan]',
        'plan file, Spec Kit directory, or a directory of plans; defaults to plan.out-dir from config',
      )
      .option('--out <path>', 'output path or directory (default plan.exec-dir from config)')
      .option('--from <format>', 'markdown | speckit | auto (auto-detects per plan)', 'auto')
      .option('--infer-deps <mode>', 'off | suggest | auto', 'off')
      .option(
        '--feature-branch <name>',
        "set plan.featureBranch in the emitted YAML (matches the MCP yaao_convert featureBranch arg)",
      )
      .action(async (input: string | undefined, flags: ConvertFlags) => {
        const cwd = resolve(ctx.cwd);
        // If no input given, fall back to the configured plan output dir (the
        // happy path: `yaao plan ...` writes there, `yaao convert` walks it).
        const resolvedInput = input ?? ctx.config.plan['out-dir'];
        const out = flags.out ?? ctx.config.plan['exec-dir'];
        const results = await convertPlans({
          cwd,
          config: ctx.config,
          input: resolvedInput,
          outDir: out,
          ...(flags.from !== undefined ? { format: flags.from } : {}),
          ...(flags.inferDeps !== undefined ? { infer: flags.inferDeps } : {}),
          ...(flags.featureBranch !== undefined ? { featureBranch: flags.featureBranch } : {}),
          agentRules: ctx.config.convert['agent-rules'],
          disableBuiltinAgentRules: ctx.config.convert['disable-builtin-rules'],
        });
        if (ctx.json) {
          process.stdout.write(
            `${JSON.stringify(
              {
                results: results.map((r) => ({
                  outPath: r.outPath,
                  tasks: r.plan.tasks.length,
                  warnings: r.warnings,
                  inferred: r.inferred,
                })),
              },
              null,
              2,
            )}\n`,
          );
        } else if (results.length === 1) {
          const r = results[0];
          if (!r) {
            ctx.exit(0);
            return;
          }
          ctx.logger.info(`✔ wrote ${r.outPath}`);
          ctx.logger.info(`  tasks: ${r.plan.tasks.length}`);
          for (const w of r.warnings) ctx.logger.warn(`  ${w}`);
          if (r.inferred.length > 0) {
            ctx.logger.info(`  inferred dependencies: ${r.inferred.length}`);
          }
          ctx.logger.info('');
          ctx.logger.info(`next: yaao validate ${r.outPath} && yaao run ${r.outPath}`);
        } else {
          ctx.logger.info(`converted ${results.length} plan(s):`);
          for (const r of results) {
            ctx.logger.info(`  ✔ ${r.outPath}  (${r.plan.tasks.length} task(s))`);
            for (const w of r.warnings) ctx.logger.warn(`      ${w}`);
          }
        }
        ctx.exit(0);
      });
  },
};
