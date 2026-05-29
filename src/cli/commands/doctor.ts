import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { CommandModule } from '../command.js';
import type { CliContext } from '../context.js';
import { runDoctor, type DoctorCheck } from '../../doctor/index.js';

interface DoctorFlags {
  strict?: boolean;
}

export const doctorCommand: CommandModule = {
  name: 'doctor',
  describe:
    "Audit the user's environment — Node, git, agent CLIs, API keys, and orphaned runs — and surface every actionable problem before it bites at run time",
  bootstrap: true,
  register(program: Command, ctx: CliContext) {
    program
      .command('doctor')
      .description(
        "Audit Node + git versions, agent CLI availability, API provider keys, project state, and orphaned runs. Pass --strict to exit non-zero on warnings (useful for CI).",
      )
      .option('--strict', 'exit non-zero on warnings as well as errors')
      .action(async (flags: DoctorFlags) => {
        const cwd = resolve(ctx.cwd);
        const report = await runDoctor({ cwd, config: ctx.config });

        if (ctx.json) {
          process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        } else {
          renderText(ctx, report.checks, report.yaao, report.node, report.os, report.git);
        }

        const failure =
          report.summary.errors > 0 ||
          (flags.strict ? report.summary.warnings > 0 : false);
        ctx.exit(failure ? 1 : 0);
      });
  },
};

function renderText(
  ctx: CliContext,
  checks: DoctorCheck[],
  yaao: string,
  node: string,
  os: string,
  git?: string,
): void {
  ctx.logger.info(
    `yaao ${yaao} · Node ${node}${git ? ` · git ${git}` : ''} · ${os}`,
  );
  ctx.logger.info('');
  const groups: DoctorCheck['group'][] = ['runtime', 'project', 'agents', 'api', 'runs'];
  for (const group of groups) {
    const rows = checks.filter((c) => c.group === group);
    if (rows.length === 0) continue;
    ctx.logger.info(group);
    for (const c of rows) {
      const marker = c.severity === 'ok' ? '✔' : c.severity === 'warning' ? '⚠' : '✘';
      ctx.logger.info(`  ${marker} ${c.name.padEnd(14)} ${c.message}`);
      if (c.hint && c.severity !== 'ok') {
        ctx.logger.info(`                  hint: ${c.hint}`);
      }
    }
    ctx.logger.info('');
  }
  const ok = checks.filter((c) => c.severity === 'ok').length;
  const warn = checks.filter((c) => c.severity === 'warning').length;
  const err = checks.filter((c) => c.severity === 'error').length;
  ctx.logger.info(`summary: ${ok} ok · ${warn} warning(s) · ${err} error(s)`);
}
