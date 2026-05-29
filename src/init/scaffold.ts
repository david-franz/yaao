import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { InitWriteError } from '../log/errors.js';
import type { AgentName } from '../config/types.js';

export type CliAgentName = Exclude<AgentName, 'api'>;

export const CLI_AGENT_NAMES: CliAgentName[] = ['claude-code', 'cursor', 'copilot', 'codex'];

export function buildDefaultConfigJson(
  enabledByAgent?: Partial<Record<CliAgentName, boolean>>,
  detectedBaseBranch?: string,
): string {
  const flag = (a: CliAgentName): boolean => enabledByAgent?.[a] ?? true;
  const baseBranch = detectedBaseBranch ?? 'main';
  return `${JSON.stringify(
    {
      // F14.8 — Points at the JSON Schema artifact emitted by
      // scripts/emit-config-schema.mjs and committed to the repo. The
      // pre-F14.8 URL (https://yaao.dev/schema/config.json) pointed at a
      // domain that doesn't exist yet; editors silently failed to
      // resolve the schema and autocomplete didn't work. The
      // raw.githubusercontent.com URL works today; Phase 18 will swap
      // to a published yaao.dev URL once the docs site stands up.
      $schema:
        'https://raw.githubusercontent.com/yaao/yaao/main/schema/config.schema.json',
      version: 1,
      defaults: {
        agent: 'claude-code',
        model: 'opus',
        'max-parallel': 4,
        // F14.9 — populated by yaao init via git.detectDefaultBranch:
        //   origin/HEAD → init.defaultBranch → 'main'. Override at
        //   init time with `yaao init --base-branch <name>`.
        'base-branch': baseBranch,
        'worktree-root': '.yaao/worktrees',
      },
      // F14.8 — history flipped from 'merge' to 'rebase' so the default
      // trio matches intent (auto / agent / rebase).
      merge: { strategy: 'auto', 'on-conflict': 'agent', history: 'rebase' },
      agents: {
        'claude-code': { enabled: flag('claude-code') },
        cursor: { enabled: flag('cursor') },
        copilot: { enabled: flag('copilot') },
        codex: { enabled: flag('codex') },
        api: { providers: {} },
      },
      'ctx-sys': { enabled: false, 'auto-spawn': true, 'require-query': false },
      // F14.8 — `speckit: false` dropped from new scaffolds (legacy
      // field, never consumed; see plan-schema doc-comment).
      plan: { format: 'markdown' },
    },
    null,
    2,
  )}\n`;
}

export const DEFAULT_CONFIG_JSON = buildDefaultConfigJson();

export const DEFAULT_SECRETS_JSON = `${JSON.stringify(
  { agents: { api: { providers: {} } } },
  null,
  2,
)}\n`;

export const DEFAULT_YAAOIGNORE = `# Files / patterns yaao should ignore when scanning the project for context.
node_modules/
dist/
build/
.next/
.turbo/
.yaao/
.git/
*.log
`;

export const GITIGNORE_BEGIN = '# >>> yaao';
export const GITIGNORE_END = '# <<< yaao';
export const GITIGNORE_BLOCK_LINES = [
  '.yaao/secrets.local.json',
  '.yaao/worktrees/',
  '.yaao/runs/',
  // Worktree stamp written by WorktreeManager at <worktree>/.yaao/.task.
  // Inside a task's worktree this file lives at `.yaao/.task` (a relative
  // path), so a generic `.yaao/.task` ignore catches it before the agent's
  // `git add -A` sweeps it into a commit.
  '.yaao/.task',
];

export function buildGitignoreBlock(): string {
  return [GITIGNORE_BEGIN, ...GITIGNORE_BLOCK_LINES, GITIGNORE_END].join('\n');
}

export interface ScaffoldOptions {
  cwd: string;
  force: boolean;
  minimal: boolean;
  /** Per-CLI availability detected by `init`. When provided, the scaffolded
   * `yaao.config.json` writes `enabled: false` for agents whose CLI we couldn't
   * find on PATH. Omitting this flag falls back to "everything enabled". */
  detectedAgents?: Partial<Record<CliAgentName, boolean>>;
  /**
   * F14.9 — Override for the scaffolded `defaults.base-branch`. When omitted,
   * init detects it via `git.detectDefaultBranch` (or 'main' as final
   * fallback). Pinned explicitly when the user passes
   * `yaao init --base-branch <name>`.
   */
  baseBranch?: string;
}

export interface ScaffoldResult {
  alreadyInitialized: boolean;
  created: string[];
  overwritten: string[];
  gitignoreUpdated: boolean;
  gitignoreSkippedReason?: 'minimal' | 'no-git';
}

interface FileSpec {
  rel: string;
  contents: string;
}

interface DirSpec {
  rel: string;
  gitkeep?: boolean;
}

const DIRS: DirSpec[] = [
  { rel: '.yaao' },
  { rel: '.yaao/plans' },
  { rel: '.yaao/exec' },
  { rel: '.yaao/skills' },
  // worktrees/ and runs/ are transient and gitignored (see .gitignore
  // additions below). No .gitkeep — committing a placeholder into a
  // gitignored directory just adds noise and forces an exception.
  { rel: '.yaao/worktrees' },
  { rel: '.yaao/runs' },
];

function filesFor(opts: ScaffoldOptions): FileSpec[] {
  return [
    {
      rel: '.yaao/yaao.config.json',
      contents: buildDefaultConfigJson(opts.detectedAgents, opts.baseBranch),
    },
    { rel: '.yaao/secrets.local.json', contents: DEFAULT_SECRETS_JSON },
  ];
}

function ensureDir(absPath: string, created: string[], rel: string): void {
  if (existsSync(absPath)) {
    if (!statSync(absPath).isDirectory()) {
      throw new InitWriteError({
        message: `expected ${rel} to be a directory but found a file`,
        path: absPath,
      });
    }
    return;
  }
  try {
    mkdirSync(absPath, { recursive: true });
  } catch (err) {
    throw new InitWriteError({
      message: `failed to create ${rel}: ${(err as Error).message}`,
      path: absPath,
      cause: err,
    });
  }
  created.push(rel);
}

function writeFileSafe(absPath: string, contents: string, rel: string): void {
  try {
    writeFileSync(absPath, contents);
  } catch (err) {
    throw new InitWriteError({
      message: `failed to write ${rel}: ${(err as Error).message}`,
      path: absPath,
      cause: err,
    });
  }
}

export function scaffoldProject(opts: ScaffoldOptions): ScaffoldResult {
  const result: ScaffoldResult = {
    alreadyInitialized: false,
    created: [],
    overwritten: [],
    gitignoreUpdated: false,
  };

  const projectAlreadyHasConfig = existsSync(join(opts.cwd, '.yaao', 'yaao.config.json'));

  for (const d of DIRS) {
    const abs = join(opts.cwd, d.rel);
    ensureDir(abs, result.created, d.rel);
    if (d.gitkeep) {
      const keep = join(abs, '.gitkeep');
      if (!existsSync(keep)) {
        writeFileSafe(keep, '', `${d.rel}/.gitkeep`);
        result.created.push(`${d.rel}/.gitkeep`);
      }
    }
  }

  for (const f of filesFor(opts)) {
    const abs = join(opts.cwd, f.rel);
    if (existsSync(abs)) {
      if (opts.force) {
        writeFileSafe(abs, f.contents, f.rel);
        result.overwritten.push(f.rel);
      }
    } else {
      writeFileSafe(abs, f.contents, f.rel);
      result.created.push(f.rel);
    }
  }

  if (!opts.minimal) {
    const yaaoignore = join(opts.cwd, '.yaaoignore');
    if (!existsSync(yaaoignore)) {
      writeFileSafe(yaaoignore, DEFAULT_YAAOIGNORE, '.yaaoignore');
      result.created.push('.yaaoignore');
    } else if (opts.force) {
      writeFileSafe(yaaoignore, DEFAULT_YAAOIGNORE, '.yaaoignore');
      result.overwritten.push('.yaaoignore');
    }

    const gi = updateGitignoreBlock(opts.cwd, opts.force);
    if (gi.updated) result.gitignoreUpdated = true;
    if (gi.skippedReason) result.gitignoreSkippedReason = gi.skippedReason;
  } else {
    result.gitignoreSkippedReason = 'minimal';
  }

  result.alreadyInitialized = projectAlreadyHasConfig && !opts.force;
  return result;
}

interface GitignoreUpdate {
  updated: boolean;
  skippedReason?: 'no-git';
}

export function updateGitignoreBlock(cwd: string, force: boolean): GitignoreUpdate {
  const gitDir = join(cwd, '.git');
  if (!existsSync(gitDir)) {
    return { updated: false, skippedReason: 'no-git' };
  }
  const giPath = join(cwd, '.gitignore');
  const block = buildGitignoreBlock();
  const existing = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
  const begin = existing.indexOf(GITIGNORE_BEGIN);
  const end = existing.indexOf(GITIGNORE_END);

  let next: string;
  if (begin === -1 && end === -1) {
    const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    const trailing = existing.length === 0 ? '' : '\n';
    next = `${existing}${sep}${trailing}${block}\n`;
  } else if (begin !== -1 && end !== -1 && end > begin) {
    if (!force) {
      // Block already present; check if its contents match. If yes, no-op. If not, no-op
      // unless --force was passed. Re-running init shouldn't churn the user's file.
      const current = existing.slice(begin, end + GITIGNORE_END.length);
      if (current === block) return { updated: false };
      return { updated: false };
    }
    const before = existing.slice(0, begin);
    const after = existing.slice(end + GITIGNORE_END.length);
    next = `${before}${block}${after}`;
  } else {
    // Malformed (one delimiter missing); refuse to touch without --force.
    if (!force) return { updated: false };
    next = `${existing.replace(/\s*$/, '')}\n\n${block}\n`;
  }

  if (next === existing) return { updated: false };
  writeFileSafe(giPath, next, '.gitignore');
  return { updated: true };
}
