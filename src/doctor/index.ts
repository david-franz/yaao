import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import type { YaaoConfig, AgentName } from '../config/types.js';
import { AGENT_NAMES } from '../config/types.js';
import { isAgentEnabled } from '../config/enabled-agents.js';
import { detectAgents } from '../agents/detect.js';
import { loadRun } from '../git/journal.js';
import { detectOrphan } from './orphan-detection.js';

/**
 * F15.1 — `yaao doctor` audit primitives.
 *
 * Returns a deterministic `DoctorReport` describing every check, its
 * severity, and an actionable hint when applicable. The shape matches
 * the F13.1 `/api/health` endpoint contract so the web viewer's
 * workspace status pill can read the same structure.
 *
 * Checks are grouped into:
 *   - runtime (node, git)
 *   - project (.yaao/ initialized, yaao.config.json schema-valid)
 *   - agents (per-agent CLI presence + version)
 *   - api    (per-provider key resolvability)
 *   - runs   (orphan-run detection)
 *
 * ctx-sys + MCP server + skill-install checks are deliberately out of
 * scope for the first cut — they require ctx-sys 2.0 (Phase 7's gated
 * dependency) and a live MCP transport. Adding them is a follow-up.
 */

export type Severity = 'ok' | 'warning' | 'error';

export interface DoctorCheck {
  group: 'runtime' | 'project' | 'agents' | 'api' | 'runs';
  name: string;
  severity: Severity;
  message: string;
  hint?: string;
}

export interface DoctorReport {
  yaao: string;
  node: string;
  git?: string;
  os: string;
  checks: DoctorCheck[];
  summary: { ok: number; warnings: number; errors: number };
}

export interface RunDoctorOptions {
  cwd: string;
  config: YaaoConfig;
}

const MIN_NODE_MAJOR = 20;
const MIN_GIT_MAJOR = 2;
const MIN_GIT_MINOR = 40;

export async function runDoctor(opts: RunDoctorOptions): Promise<DoctorReport> {
  const cwd = resolve(opts.cwd);
  const checks: DoctorCheck[] = [];

  // ----- runtime -----
  checks.push(checkNode());
  const gitProbe = await checkGit();
  checks.push(gitProbe.check);

  // ----- project -----
  const yaaoDir = join(cwd, '.yaao');
  if (existsSync(yaaoDir)) {
    checks.push({
      group: 'project',
      name: '.yaao/ initialized',
      severity: 'ok',
      message: `${yaaoDir} exists`,
    });
  } else {
    checks.push({
      group: 'project',
      name: '.yaao/ initialized',
      severity: 'warning',
      message: `${yaaoDir} not found`,
      hint: 'Run `yaao init` to scaffold this project.',
    });
  }
  // Config schema-validity: ctx.config has already been parsed via the
  // schema by the time we get here, so its presence proves validity.
  checks.push({
    group: 'project',
    name: 'yaao.config.json schema-valid',
    severity: 'ok',
    message: 'config loaded against the schema without error',
  });

  // ----- agents -----
  const availability = await detectAgents(opts.config, { noCache: true });
  for (const a of AGENT_NAMES) {
    if (a === 'api') continue;
    const enabled = isAgentEnabled(opts.config, a);
    if (!enabled) {
      checks.push({
        group: 'agents',
        name: a,
        severity: 'ok',
        message: 'disabled in yaao.config.json (skipped)',
      });
      continue;
    }
    const report = availability.byName.get(a);
    if (report?.available) {
      checks.push({
        group: 'agents',
        name: a,
        severity: 'ok',
        message: `available${report.version ? ` (v${report.version})` : ''}`,
      });
    } else {
      checks.push({
        group: 'agents',
        name: a,
        severity: 'warning',
        message: report?.reason ?? 'unavailable',
        hint: hintFor(a),
      });
    }
  }

  // ----- api providers -----
  const providers = Object.entries(opts.config.agents.api.providers ?? {});
  if (providers.length === 0) {
    checks.push({
      group: 'api',
      name: 'providers',
      severity: 'ok',
      message: 'no API providers configured (skipped)',
    });
  } else {
    for (const [name, cfg] of providers) {
      const key = cfg?.['api-key'];
      if (key && key.length > 0) {
        checks.push({
          group: 'api',
          name,
          severity: 'ok',
          message: 'API key resolves',
        });
      } else {
        checks.push({
          group: 'api',
          name,
          severity: 'warning',
          message: `provider '${name}' has no resolvable API key`,
          hint: `set ${name.toUpperCase()}_API_KEY in env or .yaao/secrets.local.json`,
        });
      }
    }
  }

  // ----- runs (orphan detection) -----
  const orphans = await findOrphanedRuns(cwd);
  if (orphans.length === 0) {
    checks.push({
      group: 'runs',
      name: 'orphan-run detection',
      severity: 'ok',
      message: 'no orphaned runs',
    });
  } else {
    for (const o of orphans) {
      checks.push({
        group: 'runs',
        name: o.runId,
        severity: 'warning',
        message: o.reason,
        hint: `inspect with \`yaao status ${o.runId}\` or remove with \`yaao_prune\``,
      });
    }
  }

  // ----- summary -----
  const summary = {
    ok: checks.filter((c) => c.severity === 'ok').length,
    warnings: checks.filter((c) => c.severity === 'warning').length,
    errors: checks.filter((c) => c.severity === 'error').length,
  };

  const report: DoctorReport = {
    yaao: '0.0.1',
    node: process.version,
    os: `${process.platform} ${process.arch}`,
    checks,
    summary,
  };
  if (gitProbe.version) report.git = gitProbe.version;
  return report;
}

function checkNode(): DoctorCheck {
  const v = process.versions.node;
  const major = parseInt(v.split('.')[0] ?? '0', 10);
  if (major >= MIN_NODE_MAJOR) {
    return {
      group: 'runtime',
      name: 'node',
      severity: 'ok',
      message: `v${v} (>= ${MIN_NODE_MAJOR})`,
    };
  }
  return {
    group: 'runtime',
    name: 'node',
    severity: 'error',
    message: `v${v} is below the minimum (>= ${MIN_NODE_MAJOR})`,
    hint: `install Node ${MIN_NODE_MAJOR} or newer (see .nvmrc)`,
  };
}

async function checkGit(): Promise<{ check: DoctorCheck; version?: string }> {
  try {
    const r = await execa('git', ['--version'], { reject: false });
    if (r.failed || r.exitCode !== 0) {
      return {
        check: {
          group: 'runtime',
          name: 'git',
          severity: 'error',
          message: 'git not found on PATH',
          hint: 'install git >= 2.40',
        },
      };
    }
    const text = (r.stdout?.toString() ?? '').trim();
    const m = text.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
    const major = m ? parseInt(m[1] ?? '0', 10) : 0;
    const minor = m ? parseInt(m[2] ?? '0', 10) : 0;
    const version = m ? `${major}.${minor}${m[3] ? `.${m[3]}` : ''}` : text;
    if (major < MIN_GIT_MAJOR || (major === MIN_GIT_MAJOR && minor < MIN_GIT_MINOR)) {
      return {
        check: {
          group: 'runtime',
          name: 'git',
          severity: 'error',
          message: `v${version} below the minimum (>= ${MIN_GIT_MAJOR}.${MIN_GIT_MINOR})`,
          hint: `install git >= ${MIN_GIT_MAJOR}.${MIN_GIT_MINOR}`,
        },
        version,
      };
    }
    return {
      check: {
        group: 'runtime',
        name: 'git',
        severity: 'ok',
        message: `v${version} (>= ${MIN_GIT_MAJOR}.${MIN_GIT_MINOR})`,
      },
      version,
    };
  } catch (err) {
    return {
      check: {
        group: 'runtime',
        name: 'git',
        severity: 'error',
        message: `git probe failed: ${(err as Error).message}`,
      },
    };
  }
}

function hintFor(agent: AgentName): string {
  switch (agent) {
    case 'claude-code':
      return 'install the claude CLI (see anthropic.com/claude-code)';
    case 'cursor':
      return 'install cursor-agent (see cursor.com/cli)';
    case 'copilot':
      return 'install gh + the gh-copilot extension (gh extension install github/gh-copilot)';
    case 'codex':
      return 'install codex CLI';
    case 'api':
      return 'configure agents.api.providers in yaao.config.json';
  }
}

interface OrphanRun {
  runId: string;
  reason: string;
}

async function findOrphanedRuns(cwd: string): Promise<OrphanRun[]> {
  const dir = join(cwd, '.yaao', 'runs');
  if (!existsSync(dir)) return [];
  const out: OrphanRun[] = [];
  for (const entry of readdirSync(dir)) {
    const runDir = join(dir, entry);
    let s;
    try {
      s = statSync(runDir);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    try {
      const { summary } = await loadRun(entry, dir);
      const detection = await detectOrphan({ runDir, summary });
      if (detection.orphaned) {
        out.push({ runId: entry, reason: detection.reason });
      }
    } catch {
      // ignore — malformed journal etc.
    }
  }
  return out;
}
