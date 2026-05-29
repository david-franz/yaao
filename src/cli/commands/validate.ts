import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { CommandModule } from '../command.js';
import type { CliContext } from '../context.js';
import { loadPlan } from '../../plan/yaml/loader.js';
import { validatePlan, type ValidationIssue } from '../../plan/validate/index.js';
import {
  PlanNotFoundError,
  PlanParseError,
  PlanValidationError,
  IncludeCycleError,
  IncludeDepthError,
  YaaoError,
} from '../../log/errors.js';
import { DEFAULT_CONFIG } from '../../config/types.js';

interface ValidateFlags {
  strict?: boolean;
  resolve?: boolean;
}

interface PerPlanResult {
  plan: string;
  ok: boolean;
  issues: ValidationIssue[];
  loadError?: { code: string; message: string };
}

export const validateCommand: CommandModule = {
  name: 'validate',
  describe: 'Validate an execution plan (YAML) against the schema and the DAG checks',
  bootstrap: true,
  register(program: Command, ctx: CliContext) {
    program
      .command('validate')
      .description(
        "Validate an execution plan against the schema + DAG checks. Surfaces every error and warning with file/line locations; --strict promotes warnings to errors (suitable for CI). Walks a directory recursively, validating every .yaml/.yml plan it finds.",
      )
      .argument('<exec-plan>', 'plan file (or directory of *.yaml plans)')
      .option('--strict', 'promote warnings to errors')
      .option('--no-resolve', 'skip default-resolution against yaao.config.json')
      .action(async (planPath: string, flags: ValidateFlags) => {
        const cwd = resolve(ctx.cwd);
        const target = resolve(cwd, planPath);
        if (!existsSync(target)) {
          ctx.logger.error(`plan not found: ${target}`, { code: 'YAAO_PLAN_NOT_FOUND' });
          ctx.exit(2);
          return;
        }
        const planFiles = collectPlanFiles(target);
        if (planFiles.length === 0) {
          ctx.logger.error(`no plan files found at ${target}`);
          ctx.exit(2);
          return;
        }

        // Commander turns `--no-resolve` into `flags.resolve === false`; the default
        // when unset is true.
        const useUserConfig = flags.resolve !== false;
        const config = useUserConfig ? ctx.config : DEFAULT_CONFIG;
        const results: PerPlanResult[] = [];
        for (const file of planFiles) {
          // eslint-disable-next-line no-await-in-loop -- per-plan validation is sequential to keep output ordered
          const r = await validateOne(file, cwd, config, flags.strict);
          results.push(r);
        }

        const exitCode = results.every((r) => r.ok) ? 0 : results.some((r) => r.loadError) ? 2 : 1;
        if (ctx.json) {
          process.stdout.write(`${JSON.stringify(results.length === 1 ? results[0] : results, null, 2)}\n`);
        } else {
          for (const r of results) printText(ctx, r);
        }
        ctx.exit(exitCode);
      });
  },
};

function collectPlanFiles(target: string): string[] {
  const s = statSync(target);
  if (s.isFile()) return [target];
  return readdirSync(target)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map((f) => join(target, f))
    .sort();
}

async function validateOne(
  file: string,
  cwd: string,
  config: typeof DEFAULT_CONFIG,
  strict: boolean | undefined,
): Promise<PerPlanResult> {
  try {
    const loaded = await loadPlan(file, { cwd, config });
    const issues = validatePlan(loaded.plan, loaded.source, { cwd, config, strict });
    return { plan: file, ok: issues.every((i) => i.severity !== 'error'), issues };
  } catch (err) {
    if (
      err instanceof PlanNotFoundError ||
      err instanceof PlanParseError ||
      err instanceof PlanValidationError ||
      err instanceof IncludeCycleError ||
      err instanceof IncludeDepthError
    ) {
      return {
        plan: file,
        ok: false,
        issues: [],
        loadError: { code: err.code, message: err.message },
      };
    }
    if (err instanceof YaaoError) {
      return {
        plan: file,
        ok: false,
        issues: [],
        loadError: { code: err.code, message: err.message },
      };
    }
    throw err;
  }
}

function printText(ctx: CliContext, r: PerPlanResult): void {
  const errors = r.issues.filter((i) => i.severity === 'error');
  const warnings = r.issues.filter((i) => i.severity === 'warning');

  if (r.loadError) {
    ctx.logger.error(`✘ ${r.plan} — ${r.loadError.code}: ${r.loadError.message}`);
    return;
  }
  if (r.ok && warnings.length === 0) {
    ctx.logger.info(`✔ ${r.plan} — ok`);
    return;
  }
  ctx.logger.info(
    `${r.ok ? '⚠' : '✘'} ${r.plan} — ${errors.length} error(s), ${warnings.length} warning(s)`,
  );
  for (const issue of r.issues) {
    const marker = issue.severity === 'error' ? '✘' : '⚠';
    const loc = issue.location ? ` (${issue.location.file}:${issue.location.line}:${issue.location.col})` : '';
    ctx.logger.info(`  ${marker} ${issue.code}${loc}: ${issue.message}`);
    if (issue.hint) ctx.logger.info(`      hint: ${issue.hint}`);
  }
}
