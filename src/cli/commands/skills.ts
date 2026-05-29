import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { CommandModule } from '../command.js';
import type { CliContext } from '../context.js';
import { installSkills, removeSkill } from '../../skills/install.js';
import { listSkillDirs, loadSkillDir, validateSkill } from '../../skills/format.js';
import { importSkill, type SkillImportScope, type SkillSourceFormat } from '../../skills/import.js';
import { getBuiltinSkillsDir } from '../../skills/builtin-dir.js';
import type { AgentName } from '../../config/types.js';
import { AGENT_NAMES } from '../../config/types.js';

interface SkillsFlags {
  agent?: string;
  force?: boolean;
  user?: boolean;
  remove?: string;
}

interface ImportFlags {
  from?: SkillSourceFormat | 'auto';
  name?: string;
  scope?: SkillImportScope;
  dryRun?: boolean;
  force?: boolean;
  noInstall?: boolean;
}

const KNOWN_AGENTS = new Set<AgentName>(AGENT_NAMES);

export const skillsCommand: CommandModule = {
  name: 'skills',
  describe: 'Install / sync / validate / list yaao skill artifacts per agent',
  register(program: Command, ctx: CliContext) {
    const skills = program
      .command('skills')
      .description(
        'Skill artifacts per agent (subcommands: install / sync / list / validate)',
      );

    skills
      .command('install')
      .description('Emit MCP-config bootstraps and managed blocks per enabled agent')
      .argument('[names...]', 'specific skills to install')
      .option('--agent <name>', 'only emit for this agent')
      .option('--force', 'overwrite hand-edited files')
      .action(async (names: string[], flags: SkillsFlags) => {
        await runInstall(ctx, names, flags);
      });

    skills
      .command('sync')
      .description('Same as install — re-emits artifacts idempotently')
      .option('--remove <name>', 'remove the named skill\'s artifacts')
      .action(async (flags: SkillsFlags) => {
        if (flags.remove) {
          const cwd = resolve(ctx.cwd);
          const changed = await removeSkill({ cwd, config: ctx.config, name: flags.remove });
          if (ctx.json) {
            process.stdout.write(`${JSON.stringify({ removed: changed }, null, 2)}\n`);
          } else {
            for (const c of changed) ctx.logger.info(`removed: ${c}`);
          }
          ctx.exit(0);
          return;
        }
        await runInstall(ctx, [], flags);
      });

    skills
      .command('list')
      .description('List discoverable skills and their source')
      .action(() => {
        const cwd = resolve(ctx.cwd);
        const rows = listSkillDirs({ cwd, skipUser: false });
        if (ctx.json) {
          process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        } else {
          for (const r of rows) ctx.logger.info(`${r.name.padEnd(20)} ${r.source.padEnd(8)} ${r.dir}`);
        }
        ctx.exit(0);
      });

    skills
      .command('validate')
      .description('Validate each discoverable skill against the schema and placeholder rules')
      .argument('[names...]', 'specific skills to validate')
      .action((names: string[]) => {
        const cwd = resolve(ctx.cwd);
        const dirs = listSkillDirs({ cwd, skipUser: false }).filter(
          (d) => names.length === 0 || names.includes(d.name),
        );
        let failed = 0;
        const reports: { name: string; ok: boolean; issues: { code: string; message: string }[] }[] = [];
        for (const d of dirs) {
          try {
            const skill = loadSkillDir(d.dir);
            if (!skill) {
              reports.push({ name: d.name, ok: false, issues: [{ code: 'YAAO_SKILL_MISSING_FILES', message: 'missing skill.yaml or prompt.md' }] });
              failed += 1;
              continue;
            }
            const v = validateSkill(skill);
            reports.push({ name: d.name, ok: v.ok, issues: v.issues });
            if (!v.ok) failed += 1;
          } catch (err) {
            reports.push({ name: d.name, ok: false, issues: [{ code: 'YAAO_SKILL_LOAD_ERROR', message: (err as Error).message }] });
            failed += 1;
          }
        }
        if (ctx.json) {
          process.stdout.write(`${JSON.stringify({ reports }, null, 2)}\n`);
        } else {
          for (const r of reports) {
            ctx.logger.info(`${r.ok ? '✔' : '✘'} ${r.name}`);
            for (const i of r.issues) ctx.logger.info(`    ${i.code}: ${i.message}`);
          }
        }
        ctx.exit(failed > 0 ? 1 : 0);
      });

    skills
      .command('import')
      .description(
        'Import a Claude / Cursor / Copilot / Codex / generic-markdown skill into the yaao skill format so every yaao-supported agent can call it via MCP',
      )
      .argument('<source>', 'path to the source artifact (SKILL.md, .mdc, .md, or Claude skill directory)')
      .option('--from <fmt>', 'claude | cursor | copilot | codex | generic | auto', 'auto')
      .option('--name <slug>', 'override the derived skill name')
      .option('--scope <scope>', 'project | user (where to write)', 'project')
      .option('--dry-run', "print what would happen without writing anything")
      .option('--force', 'overwrite an existing yaao skill with the same name')
      .option('--no-install', 'skip the post-import `yaao skills install` re-emit')
      .action(async (source: string, flags: ImportFlags) => {
        const cwd = resolve(ctx.cwd);
        const r = importSkill({
          cwd,
          source,
          ...(flags.from !== undefined ? { from: flags.from } : {}),
          ...(flags.name !== undefined ? { name: flags.name } : {}),
          ...(flags.scope !== undefined ? { scope: flags.scope } : {}),
          ...(flags.dryRun !== undefined ? { dryRun: flags.dryRun } : {}),
          ...(flags.force !== undefined ? { force: flags.force } : {}),
          ...(flags.noInstall !== undefined ? { noInstall: flags.noInstall } : {}),
        });
        // Post-import re-emit: get the per-agent stubs back in sync so
        // the new skill shows up as yaao_skill_<name>. Skip on dry-run
        // and on --no-install (the user is staging multiple imports).
        if (!r.dryRun && !flags.noInstall) {
          await installSkills({ cwd, config: ctx.config, only: [r.name] });
        }
        if (ctx.json) {
          process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
        } else {
          ctx.logger.info(
            `${r.dryRun ? 'would import' : 'imported'} ${r.format} skill '${r.name}' → ${r.destination}`,
          );
          for (const w of r.written) ctx.logger.info(`  ${w.rel}  (${w.bytes} bytes)`);
          if (r.validation.ok) {
            ctx.logger.info(r.dryRun ? '  validation: ok (dry-run)' : '  validation: ok');
          } else {
            for (const i of r.validation.issues) {
              ctx.logger.warn(`  ${i.code}: ${i.message}`);
            }
          }
        }
        ctx.exit(r.validation.ok ? 0 : 1);
      });
  },
};

async function runInstall(ctx: CliContext, names: string[], flags: SkillsFlags): Promise<void> {
  const cwd = resolve(ctx.cwd);
  const agent = parseAgent(flags.agent, ctx);
  const builtinDir = getBuiltinSkillsDir();
  const result = await installSkills({
    cwd,
    config: ctx.config,
    ...(names.length > 0 ? { only: names } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(flags.force !== undefined ? { force: flags.force } : {}),
    ...(builtinDir !== undefined ? { builtinDir } : {}),
  });
  if (ctx.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const w of result.warnings) ctx.logger.warn(w);
    for (const s of result.skills) {
      ctx.logger.info(`${s.name} → ${s.emittedFor.join(', ')}: ${s.changedFiles.length} file(s)`);
    }
  }
  ctx.exit(result.warnings.length > 0 ? 1 : 0);
}

function parseAgent(name: string | undefined, ctx: CliContext): AgentName | undefined {
  if (!name) return undefined;
  if (!KNOWN_AGENTS.has(name as AgentName)) {
    ctx.logger.error(`unknown agent: ${name}; expected one of ${[...KNOWN_AGENTS].join(', ')}`);
    ctx.exit(2);
  }
  return name as AgentName;
}
