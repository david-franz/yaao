/**
 * Pure tool handlers used by the yaao MCP server. Each handler returns a structured
 * result + a content string (the latter is what an MCP client surfaces to a user).
 * Wiring into the SDK lives in src/mcp/server.ts.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { YaaoConfig } from '../config/types.js';
import {
  resolveSkill,
  substitutePlaceholders,
  listSkillDirs,
  validateSkill,
  type LoadedSkill,
} from '../skills/format.js';
import { getBuiltinSkillsDir } from '../skills/builtin-dir.js';
import { runPlanner } from '../planner/run.js';
import { convertPlan } from '../converter/convert.js';
import { loadPlan } from '../plan/yaml/loader.js';
import { runPlan } from '../exec/runner.js';
import { listRuns, loadRun } from '../git/journal.js';
import type { AgentBackend, AgentName } from '../agents/backend.js';
import { ClaudeCodeBackend } from '../agents/claude-code.js';
import { CursorBackend } from '../agents/cursor.js';
import { CopilotBackend } from '../agents/copilot.js';
import { CodexBackend } from '../agents/codex.js';
import { YaaoError } from '../log/errors.js';

export interface ToolContext {
  cwd: string;
  config: YaaoConfig;
  /** Override the backend factory (tests use this to inject a FakeBackend). */
  backendFor?: (agent: AgentName) => AgentBackend;
}

export interface ToolCallResult {
  /** Plain-text payload the MCP client should surface (e.g. via `content: [{ type: 'text' }]`). */
  text: string;
  /** Structured metadata. Returned via the MCP tool's `structuredContent`. */
  structuredContent: Record<string, unknown>;
}

/** ---- yaao_plan ----------------------------------------------------------------- */

export interface PlanToolInput {
  description: string;
  scope?: 'feature' | 'project';
  format?: 'markdown' | 'speckit' | 'both';
  out?: string;
  agent?: AgentName;
}

export async function yaaoPlanTool(input: PlanToolInput, ctx: ToolContext): Promise<ToolCallResult> {
  const agent = input.agent ?? ctx.config.defaults.agent;
  const backend = (ctx.backendFor ?? defaultBackendFor)(agent);
  const result = await runPlanner({
    cwd: ctx.cwd,
    config: ctx.config,
    description: input.description,
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.format !== undefined ? { format: input.format } : {}),
    ...(input.out !== undefined ? { outDir: input.out } : {}),
    backend,
  });
  const files = result.files.map((f) => f.replace(`${resolve(ctx.cwd)}/`, ''));
  return {
    text: files.length > 0 ? `Wrote ${files.length} plan file(s):\n${files.join('\n')}` : '(no files written)',
    structuredContent: {
      ok: result.ok,
      files,
      tasks: result.plan?.tasks.length ?? 0,
      scope: result.scope,
      format: result.format,
    },
  };
}

/** ---- yaao_convert -------------------------------------------------------------- */

export interface ConvertToolInput {
  input: string;
  out?: string;
  inferDeps?: 'off' | 'suggest' | 'auto';
}

export async function yaaoConvertTool(input: ConvertToolInput, ctx: ToolContext): Promise<ToolCallResult> {
  const r = await convertPlan({
    cwd: ctx.cwd,
    config: ctx.config,
    input: input.input,
    ...(input.out !== undefined ? { out: input.out } : {}),
    ...(input.inferDeps !== undefined ? { infer: input.inferDeps } : {}),
  });
  return {
    text: `Wrote ${r.outPath} with ${r.plan.tasks.length} task(s).`,
    structuredContent: {
      outPath: r.outPath,
      tasks: r.plan.tasks.length,
      warnings: r.warnings,
      inferred: r.inferred,
    },
  };
}

/** ---- yaao_validate ------------------------------------------------------------- */

export interface ValidateToolInput {
  plan: string;
}

export async function yaaoValidateTool(input: ValidateToolInput, ctx: ToolContext): Promise<ToolCallResult> {
  const planAbs = resolve(ctx.cwd, input.plan);
  if (!existsSync(planAbs)) {
    throw new YaaoError({ code: 'YAAO_PLAN_NOT_FOUND', message: `plan not found: ${planAbs}` });
  }
  const { validatePlan } = await import('../plan/validate/index.js');
  const loaded = await loadPlan(planAbs, { cwd: resolve(ctx.cwd), config: ctx.config });
  const issues = validatePlan(loaded.plan, loaded.source, {
    cwd: ctx.cwd,
    config: ctx.config,
  });
  const errs = issues.filter((i) => i.severity === 'error');
  return {
    text: errs.length === 0 ? '✔ plan ok' : `${errs.length} error(s); ${issues.length - errs.length} warning(s)`,
    structuredContent: { ok: errs.length === 0, issues },
  };
}

/** ---- yaao_run + yaao_status ---------------------------------------------------- */

export interface RunToolInput {
  plan: string;
  only?: string[];
  skip?: string[];
  trial?: boolean;
}

export async function yaaoRunTool(input: RunToolInput, ctx: ToolContext): Promise<ToolCallResult> {
  const cwd = resolve(ctx.cwd);
  const planAbs = resolve(cwd, input.plan);
  const loaded = await loadPlan(planAbs, { cwd, config: ctx.config });
  const runId = `run-${Date.now().toString(36)}`;
  const result = await runPlan({
    runId,
    plan: loaded.plan,
    planFile: planAbs,
    rootDir: cwd,
    config: ctx.config,
    backendFor: (task) => (ctx.backendFor ?? defaultBackendFor)(task.agent),
    ...(input.only || input.skip
      ? { filter: { ...(input.only ? { only: input.only } : {}), ...(input.skip ? { skip: input.skip } : {}) } }
      : {}),
    ...(input.trial !== undefined ? { trial: input.trial } : {}),
  });
  return {
    text: `run ${runId} ${result.status} in ${result.durationMs}ms`,
    structuredContent: { runId, status: result.status, durationMs: result.durationMs },
  };
}

export interface StatusToolInput {
  runId?: string;
}

export async function yaaoStatusTool(input: StatusToolInput, ctx: ToolContext): Promise<ToolCallResult> {
  const cwd = resolve(ctx.cwd);
  const journalDir = join(cwd, '.yaao', 'runs');
  const runs = await listRuns(journalDir);
  const target = input.runId ? runs.find((r) => r.runId === input.runId) : runs[0];
  if (!target) {
    throw new YaaoError({ code: 'YAAO_NO_RUNS', message: 'no runs found' });
  }
  const { summary } = await loadRun(target.runId, journalDir);
  return {
    text: `run ${summary.runId} status=${summary.status}`,
    structuredContent: { ...summary },
  };
}

/** ---- yaao_agents --------------------------------------------------------------- */

export async function yaaoAgentsTool(_input: Record<string, never>, ctx: ToolContext): Promise<ToolCallResult> {
  const { detectAgents } = await import('../agents/detect.js');
  const r = await detectAgents(ctx.config);
  const list: Record<string, { available: boolean; version?: string; reason?: string }> = {};
  for (const [name, report] of r.byName) {
    list[name] = {
      available: report.available,
      ...(report.version !== undefined ? { version: report.version } : {}),
      ...(report.reason !== undefined ? { reason: report.reason } : {}),
    };
  }
  return {
    text: Object.entries(list)
      .map(([k, v]) => `${v.available ? '✔' : '✘'} ${k}`)
      .join('\n'),
    structuredContent: { agents: list },
  };
}

/** ---- yaao_plans ---------------------------------------------------------------- */

export async function yaaoPlansTool(_input: Record<string, never>, ctx: ToolContext): Promise<ToolCallResult> {
  const cwd = resolve(ctx.cwd);
  const dirs: { plans: string[]; exec: string[] } = { plans: [], exec: [] };
  const plansDir = join(cwd, '.yaao', 'plans');
  const execDir = join(cwd, '.yaao', 'exec');
  if (existsSync(plansDir)) dirs.plans = readdirSync(plansDir).filter((f) => f.endsWith('.md'));
  if (existsSync(execDir)) dirs.exec = readdirSync(execDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  return {
    text: `plans: ${dirs.plans.length}\nexec: ${dirs.exec.length}`,
    structuredContent: dirs as unknown as Record<string, unknown>,
  };
}

/** ---- yaao_skill_<name>  -------------------------------------------------------- */

export interface SkillToolInput {
  [k: string]: string | undefined;
}

export interface DiscoveredSkill {
  name: string;
  description: string;
  /** Property-name → required flag for input validation hints. */
  inputs: { name: string; description?: string; required: boolean; default?: string }[];
}

export function discoverSkills(ctx: ToolContext): DiscoveredSkill[] {
  const builtinDir = getBuiltinSkillsDir();
  const dirs = listSkillDirs({
    cwd: ctx.cwd,
    skipUser: false,
    ...(builtinDir !== undefined ? { builtinDir } : {}),
  });
  const out: DiscoveredSkill[] = [];
  for (const d of dirs) {
    try {
      const skill = resolveSkill(d.name, {
        cwd: ctx.cwd,
        skipUser: false,
        ...(builtinDir !== undefined ? { builtinDir } : {}),
      });
      if (!skill) continue;
      const v = validateSkill(skill);
      if (!v.ok) continue;
      out.push({
        name: skill.metadata.name,
        description: skill.metadata.description,
        inputs: skill.metadata.inputs.map((i) => ({
          name: i.name,
          ...(i.description !== undefined ? { description: i.description } : {}),
          required: i.required ?? false,
          ...(i.default !== undefined ? { default: i.default } : {}),
        })),
      });
    } catch {
      // Skip malformed skills; surface separately via `yaao skills validate`.
    }
  }
  return out;
}

export function yaaoSkillTool(skillName: string, input: SkillToolInput, ctx: ToolContext): ToolCallResult {
  const builtinDir = getBuiltinSkillsDir();
  const skill: LoadedSkill | undefined = resolveSkill(skillName, {
    cwd: ctx.cwd,
    ...(builtinDir !== undefined ? { builtinDir } : {}),
  });
  if (!skill) {
    throw new YaaoError({
      code: 'YAAO_SKILL_NOT_FOUND',
      message: `skill not found: ${skillName}`,
    });
  }
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) if (v !== undefined) values[k] = v;
  const body = substitutePlaceholders(skill.prompt, values, skill.metadata.inputs);
  return {
    text: body,
    structuredContent: {
      skill: skill.metadata.name,
      version: skill.metadata.version,
      inputs: values,
    },
  };
}

/** Read a skill body to support tests / debugging without invoking the tool. */
export function readBuiltinSkill(name: string): string | undefined {
  const dir = getBuiltinSkillsDir();
  if (!dir) return undefined;
  const p = join(dir, name, 'prompt.md');
  if (!existsSync(p)) return undefined;
  return readFileSync(p, 'utf8');
}

function defaultBackendFor(agent: AgentName): AgentBackend {
  switch (agent) {
    case 'claude-code':
      return new ClaudeCodeBackend();
    case 'cursor':
      return new CursorBackend();
    case 'copilot':
      return new CopilotBackend();
    case 'codex':
      return new CodexBackend();
    case 'api':
      throw new YaaoError({
        code: 'YAAO_MCP_API_BACKEND_UNSUPPORTED',
        message: 'the api backend is not supported via yaao serve in MVP; use a CLI agent',
      });
  }
}
