import { resolve } from 'node:path';
import type { YaaoConfig, AgentName } from '../config/types.js';
import { enabledAgents as configEnabledAgents } from '../config/enabled-agents.js';
import { listSkillDirs, loadSkillDir, validateSkill, type LoadedSkill, type ValidateResult } from './format.js';
import { emitClaudeCode, removeClaudeCodeSkill } from './emitters/claude-code.js';
import { emitCursor, removeCursorSkill } from './emitters/cursor.js';
import { emitCopilot, removeCopilotSkill } from './emitters/copilot.js';
import { emitCodex, removeCodexSkill } from './emitters/codex.js';

export interface InstallOptions {
  cwd: string;
  config: YaaoConfig;
  /** Limit to these skill names; otherwise install all discovered skills. */
  only?: string[];
  /** Restrict emitters to a single agent. */
  agent?: AgentName;
  /** Built-in skills directory (Phase 9/10 will populate this). */
  builtinDir?: string;
  force?: boolean;
  /** When true, validate all discovered skills before emitting and abort on errors. */
  strictValidate?: boolean;
}

export interface SkillSummary {
  name: string;
  source: 'project' | 'user' | 'builtin';
  origin: string;
  emittedFor: AgentName[];
  changedFiles: string[];
  skipped?: string;
}

export interface InstallReport {
  skills: SkillSummary[];
  warnings: string[];
}

const EMITTERS: Record<
  Exclude<AgentName, 'api'>,
  {
    emit: (skills: LoadedSkill[], opts: { cwd: string; force?: boolean }) => { files: { path: string; changed: boolean }[] };
    remove: (name: string, opts: { cwd: string }) => { files: { path: string; changed: boolean }[] };
  }
> = {
  'claude-code': { emit: emitClaudeCode, remove: removeClaudeCodeSkill },
  cursor: { emit: emitCursor, remove: removeCursorSkill },
  copilot: { emit: emitCopilot, remove: removeCopilotSkill },
  codex: { emit: emitCodex, remove: removeCodexSkill },
};

export async function installSkills(opts: InstallOptions): Promise<InstallReport> {
  const cwd = resolve(opts.cwd);
  const enabled = enabledAgents(opts.config, opts.agent);
  const discovered = listSkillDirs({
    cwd,
    skipUser: false,
    ...(opts.builtinDir !== undefined ? { builtinDir: opts.builtinDir } : {}),
  });
  const filtered = opts.only ? discovered.filter((d) => opts.only?.includes(d.name)) : discovered;

  const report: InstallReport = { skills: [], warnings: [] };
  const loaded: { skill: LoadedSkill; source: 'project' | 'user' | 'builtin' }[] = [];

  for (const d of filtered) {
    try {
      const s = loadSkillDir(d.dir);
      if (!s) {
        report.warnings.push(`skill '${d.name}' missing skill.yaml or prompt.md (origin: ${d.dir})`);
        continue;
      }
      const v: ValidateResult = validateSkill(s);
      if (!v.ok && opts.strictValidate) {
        report.warnings.push(
          `skill '${d.name}' has validation issues: ${v.issues.map((i) => i.code).join(', ')}`,
        );
        continue;
      }
      loaded.push({ skill: s, source: d.source });
    } catch (err) {
      report.warnings.push(`skill '${d.name}' failed to load: ${(err as Error).message}`);
    }
  }

  // Run each enabled emitter once with the full set of applicable skills so the emitter
  // can deduplicate writes (Cursor emits a single `yaao.mdc` with all skill blocks).
  for (const agent of enabled) {
    if (agent === 'api') continue; // API backend reads MCP servers at SDK level, no on-disk artifacts
    const entry = EMITTERS[agent];
    const applicable = loaded.filter((l) => l.skill.metadata.appliesTo.agents.includes(agent));
    if (applicable.length === 0) continue;
    const result = entry.emit(
      applicable.map((l) => l.skill),
      { cwd, ...(opts.force !== undefined ? { force: opts.force } : {}) },
    );
    for (const l of applicable) {
      const summary = report.skills.find((s) => s.name === l.skill.metadata.name);
      if (summary) {
        summary.emittedFor.push(agent);
        for (const f of result.files) {
          if (f.changed && !summary.changedFiles.includes(f.path)) summary.changedFiles.push(f.path);
        }
      } else {
        report.skills.push({
          name: l.skill.metadata.name,
          source: l.source,
          origin: l.skill.origin,
          emittedFor: [agent],
          changedFiles: result.files.filter((f) => f.changed).map((f) => f.path),
        });
      }
    }
  }
  return report;
}

export interface RemoveOptions {
  cwd: string;
  config: YaaoConfig;
  name: string;
}

export async function removeSkill(opts: RemoveOptions): Promise<string[]> {
  const cwd = resolve(opts.cwd);
  const enabled = enabledAgents(opts.config);
  const changed: string[] = [];
  for (const agent of enabled) {
    if (agent === 'api') continue;
    const r = EMITTERS[agent].remove(opts.name, { cwd });
    for (const f of r.files) {
      if (f.changed) changed.push(`${agent}:${f.path}`);
    }
  }
  return changed;
}

function enabledAgents(config: YaaoConfig, override?: AgentName): AgentName[] {
  if (override) return [override];
  return configEnabledAgents(config);
}
