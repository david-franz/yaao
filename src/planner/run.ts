import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentBackend, AgentEvent, SpawnOptions } from '../agents/backend.js';
import type { YaaoConfig } from '../config/types.js';
import { resolveSkill, substitutePlaceholders, type LoadedSkill } from '../skills/format.js';
import { parseMarkdownPlan, type ParsedPlan } from './markdown.js';
import { parseSpecKit } from './speckit.js';
import { suggestScope, type PlanScope } from './scope.js';
import { getBuiltinSkillsDir } from '../skills/builtin-dir.js';
import { YaaoError, AgentUnavailableError } from '../log/errors.js';

export interface RunPlannerOptions {
  cwd: string;
  config: YaaoConfig;
  description: string;
  scope?: PlanScope;
  format?: 'markdown' | 'speckit' | 'both';
  outDir?: string;
  /** When true, return the resolved prompt without spawning an agent. */
  dryRun?: boolean;
  /** Backend factory; in production this would build a real backend from config. */
  backend: AgentBackend;
  /**
   * Called for each agent event (stdout text chunk, tool-use, etc) plus periodic
   * `tick` events while waiting. The CLI uses this to print progress to stderr;
   * tests/MCP can ignore it.
   */
  onProgress?: (ev: ProgressEvent) => void;
}

export type ProgressEvent =
  | { type: 'spawn'; agent: string }
  | { type: 'agent'; event: AgentEvent }
  | { type: 'tick'; elapsedMs: number }
  | { type: 'done'; durationMs: number; files: string[] };

export interface RunPlannerResult {
  ok: boolean;
  scope: PlanScope;
  format: 'markdown' | 'speckit' | 'both';
  /** Resolved prompt body sent to the agent (handy for --dry-run). */
  prompt: string;
  /** Paths to the plan file(s) that were produced/found. */
  files: string[];
  /** Parsed plan IR, when at least one file parsed. */
  plan?: ParsedPlan;
  /** Issues raised by the format parser. */
  issues: { code: string; message: string }[];
}

export async function runPlanner(opts: RunPlannerOptions): Promise<RunPlannerResult> {
  const cwd = resolve(opts.cwd);
  const builtinDir = getBuiltinSkillsDir();
  const skill: LoadedSkill | undefined = resolveSkill('yaao-planner', {
    cwd,
    ...(builtinDir !== undefined ? { builtinDir } : {}),
  });
  if (!skill) {
    throw new YaaoError({
      code: 'YAAO_PLANNER_SKILL_MISSING',
      message: 'built-in yaao-planner skill not found; reinstall yaao',
    });
  }

  const scope = opts.scope ?? suggestScope(opts.description).scope;
  const format = opts.format ?? 'markdown';
  const outDir = opts.outDir ?? join(cwd, '.yaao', 'plans');

  const prompt = substitutePlaceholders(
    skill.prompt,
    {
      description: opts.description,
      scope,
      format,
      out: outDir,
    },
    skill.metadata.inputs,
  );

  if (opts.dryRun) {
    return { ok: true, scope, format, prompt, files: [], issues: [] };
  }

  // Pre-flight: backend must be available.
  const availability = await opts.backend.isAvailable();
  if (!availability.available) {
    throw new AgentUnavailableError({
      message: `agent '${opts.backend.name}' is unavailable for yaao plan: ${availability.reason ?? '?'}`,
      agent: opts.backend.name,
    });
  }

  // Snapshot the out directory so we can detect what the agent wrote.
  const before = snapshot(outDir);

  // Spawn the agent. The skill prompt instructs it to write the plan file(s) to outDir.
  const spawnOpts: SpawnOptions = {
    cwd,
    prompt,
    skills: ['yaao-planner'],
  };
  const startedAt = Date.now();
  opts.onProgress?.({ type: 'spawn', agent: opts.backend.name });
  const proc = await opts.backend.spawn(spawnOpts);
  // Drain events so the backend can complete, forwarding each to onProgress.
  void (async () => {
    for await (const ev of proc.events) {
      opts.onProgress?.({ type: 'agent', event: ev });
    }
  })();
  // While we wait, emit a tick once per second so a parent CLI can show
  // "agent running 0:42…" — proves the run isn't hung.
  const ticker = setInterval(() => {
    opts.onProgress?.({ type: 'tick', elapsedMs: Date.now() - startedAt });
  }, 1000);
  try {
    await proc.completed;
  } finally {
    clearInterval(ticker);
  }

  const after = snapshot(outDir);
  const newFiles = after.filter((f) => !before.includes(f));
  const issues: { code: string; message: string }[] = [];
  let parsed: ParsedPlan | undefined;
  for (const f of newFiles) {
    const body = readFileSync(f, 'utf8');
    if (f.endsWith('tasks.md')) {
      parsed = parseSpecKit({ tasks: body });
    } else if (f.endsWith('.md')) {
      parsed = parseMarkdownPlan(body);
    }
    if (parsed) for (const i of parsed.issues) issues.push(i);
  }

  opts.onProgress?.({ type: 'done', durationMs: Date.now() - startedAt, files: newFiles });
  return {
    ok: newFiles.length > 0 && issues.every((i) => !i.code.startsWith('YAAO_PLAN_TASK_ID_INVALID')),
    scope,
    format,
    prompt,
    files: newFiles,
    ...(parsed !== undefined ? { plan: parsed } : {}),
    issues,
  };
}

function snapshot(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isFile()) out.push(full);
  }
  return out;
}
