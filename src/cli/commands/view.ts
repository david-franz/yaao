import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { CommandModule } from '../command.js';
import type { CliContext } from '../context.js';
import { loadPlan } from '../../plan/yaml/loader.js';
import { renderDag } from '../../tui/render-dag.js';

interface ViewFlags {
  ascii?: boolean;
  width?: string;
}

export const viewCommand: CommandModule = {
  name: 'view',
  describe: 'Render an execution plan as a text DAG',
  bootstrap: true,
  register(program: Command, ctx: CliContext) {
    program
      .command('view')
      .description('Render an execution plan as a text DAG')
      .argument('<exec-plan>', 'execution plan (YAML)')
      .option('--ascii', 'use ASCII status icons instead of Unicode')
      .option('--width <n>', 'max display width', '100')
      .action(async (planPath: string, flags: ViewFlags) => {
        const cwd = resolve(ctx.cwd);
        const abs = resolve(cwd, planPath);
        if (!existsSync(abs)) {
          ctx.logger.error(`plan not found: ${abs}`);
          ctx.exit(2);
          return;
        }
        const loaded = await loadPlan(abs, { cwd, config: ctx.config });
        const w = Number(flags.width ?? '100');
        const out = renderDag(loaded.plan, {
          ...(flags.ascii !== undefined ? { ascii: flags.ascii } : {}),
          maxWidth: Number.isFinite(w) && w > 0 ? w : 100,
        });
        if (ctx.json) {
          process.stdout.write(`${JSON.stringify({ layers: out.layers }, null, 2)}\n`);
        } else {
          process.stdout.write(out.text);
          process.stdout.write('\n');
        }
        ctx.exit(0);
      });
  },
};
