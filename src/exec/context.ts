import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ResolvedPlan, ResolvedTask } from '../plan/schema/types.js';

export interface ContextDirOptions {
  runDir: string;
}

/**
 * F16.3 — Sections the parent→child context handoff can include in the
 * generated `context.md` artifact. Each name maps to one rendered
 * section under the existing artifact layout. The default
 * (`include: undefined`) emits all four — opt out by setting
 * `config.context.include: []` (or any subset) in the plan.
 */
export type ContextSection = 'prompt' | 'validation' | 'commits' | 'diff';

export const DEFAULT_CONTEXT_SECTIONS: ContextSection[] = ['prompt', 'validation', 'commits', 'diff'];

export interface TaskOutcomeArtifact {
  branch: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: { path: string; status: 'added' | 'modified' | 'removed' | 'renamed' }[];
  /** Tail of the agent's stdout, deduplicated and trimmed. */
  summary: string;
  commit?: string;
  commitSubject?: string;
  /**
   * F16.3 — Parent task's resolved prompt body (the planner's prompt-ref
   * content, or the inline task.prompt). When present and `include`
   * permits, the first 30 lines are rendered under `## Original task` so
   * a downstream agent reading the artifact knows *what the parent was
   * asked to do*, not just what its stdout said.
   */
  originalPrompt?: string;
  /**
   * F16.3 — Captured validation outcome (command, exit code, duration,
   * decision reason, must-pass). When present and `include` permits,
   * rendered under `## Validation` so a dependent agent sees whether
   * the parent's tests/lint passed.
   */
  validation?: {
    command: string;
    exitCode: number;
    durationMs: number;
    mustPass: boolean;
    decisionReason: string;
  };
  /**
   * F16.3 — Full commit chain `baseCommit..HEAD` on the parent's
   * branch — one entry per commit, newest first. Replaces the single
   * "Commit" section's head-only view so multi-commit tasks surface
   * their full trajectory.
   */
  commits?: { sha: string; subject: string }[];
  /**
   * F16.3 — `git diff --stat <baseBranch>...HEAD` output, trimmed to
   * the configured cap so the artifact stays under budget.
   */
  diffStat?: string;
}

export const DEFAULT_PER_DEP_TOKEN_BUDGET = 2000;
export const DEFAULT_TOTAL_TOKEN_BUDGET = 12_000;
const PROMPT_PREVIEW_LINES = 30;
const DIFF_STAT_LINE_CAP = 30;

export interface WriteContextMdOptions {
  /** Subset of sections to render. Defaults to all four. Pass `[]` to
   * reproduce the pre-F16.3 artifact shape byte-for-byte. */
  include?: ContextSection[];
}

export function writeContextMd(
  runDir: string,
  task: ResolvedTask,
  artifact: TaskOutcomeArtifact,
  opts: WriteContextMdOptions = {},
): string {
  const dir = join(runDir, task.id);
  mkdirSync(dir, { recursive: true });
  const sections = opts.include ?? DEFAULT_CONTEXT_SECTIONS;
  const include = new Set(sections);

  const summaryLines = artifact.summary.trim().split(/\r?\n/);
  const lastN = summaryLines.slice(-80).join('\n');
  const fileList = artifact.files
    .map((f) => `- \`${f.path}\` (${f.status})`)
    .join('\n');

  // Header is unchanged by F16.3 — existing readers keep working.
  const out: string[] = [
    `# ${task.id} — ${task.title}`,
    '',
    `**Branch**: ${artifact.branch}`,
    `**Files changed**: ${artifact.filesChanged} (+${artifact.insertions} / -${artifact.deletions})`,
    '',
  ];

  // F16.3 additions are rendered in a fixed order so a reader can rely
  // on the layout. Each section is omitted entirely when its data is
  // absent OR when `include` excludes it — no empty headings.

  if (include.has('prompt') && artifact.originalPrompt && artifact.originalPrompt.trim().length > 0) {
    const lines = artifact.originalPrompt.trim().split(/\r?\n/);
    const preview = lines.slice(0, PROMPT_PREVIEW_LINES).join('\n');
    const truncated = lines.length > PROMPT_PREVIEW_LINES;
    out.push('## Original task');
    out.push('');
    out.push(preview);
    if (truncated) {
      out.push('');
      out.push(`_(truncated at ${PROMPT_PREVIEW_LINES} lines)_`);
    }
    out.push('');
  }

  if (include.has('validation') && artifact.validation) {
    const v = artifact.validation;
    out.push('## Validation');
    out.push('');
    out.push(`- Command: \`${v.command}\``);
    out.push(
      `- Exit code: ${v.exitCode} (${v.exitCode === 0 ? 'passed' : 'failed'}, must-pass=${v.mustPass})`,
    );
    out.push(`- Duration: ${v.durationMs}ms`);
    out.push(`- Decision: ${v.decisionReason}`);
    out.push('');
  }

  // Summary stays where it always was — between the new "Original task" /
  // "Validation" sections and the new "Diff" / "Commits" sections.
  out.push('## Summary');
  out.push('');
  out.push(lastN);
  out.push('');

  if (include.has('diff') && artifact.diffStat && artifact.diffStat.trim().length > 0) {
    const diffLines = artifact.diffStat.trim().split(/\r?\n/);
    const cappedDiff = diffLines.slice(0, DIFF_STAT_LINE_CAP).join('\n');
    const truncated = diffLines.length > DIFF_STAT_LINE_CAP;
    out.push('## Diff');
    out.push('');
    out.push('```');
    out.push(cappedDiff);
    out.push('```');
    if (truncated) {
      out.push('');
      out.push(`_(diff stat truncated at ${DIFF_STAT_LINE_CAP} lines)_`);
    }
    out.push('');
  }

  if (include.has('commits') && artifact.commits && artifact.commits.length > 0) {
    out.push('## Commits');
    out.push('');
    for (const c of artifact.commits) {
      out.push(`- ${c.sha.slice(0, 7)} ${c.subject}`);
    }
    out.push('');
  } else {
    // Legacy single-head commit fallback when F16.3's full chain is
    // absent (e.g. when the lifecycle didn't capture it, or when
    // include explicitly opts out of commits and the legacy artifact
    // shape is wanted).
    out.push('## Commit');
    out.push('');
    out.push(
      artifact.commit
        ? `${artifact.commit.slice(0, 7)} ${artifact.commitSubject ?? task.title}`
        : '_(no commit)_',
    );
    out.push('');
  }

  out.push('## Files');
  out.push('');
  out.push(fileList || '_(none)_');
  out.push('');

  const path = join(dir, 'context.md');
  writeFileSync(path, out.join('\n'));
  return path;
}

/**
 * Build the context prefix prepended to a task's prompt. Walks the plan to find every
 * completed dependency (transitive=false: just `depends:`), inlines each upstream
 * `context.md`, applies per-dep + total token budgets.
 */
export function buildContextPrefix(opts: {
  runDir: string;
  plan: ResolvedPlan;
  task: ResolvedTask;
  perDepBudget?: number;
  totalBudget?: number;
}): { prefix: string; truncated: boolean } {
  const perDep = opts.perDepBudget ?? DEFAULT_PER_DEP_TOKEN_BUDGET;
  const total = opts.totalBudget ?? DEFAULT_TOTAL_TOKEN_BUDGET;
  if (opts.task.depends.length === 0) return { prefix: '', truncated: false };

  // Sort deps topologically-then-lex (we don't have full topo here; use plan order +
  // lex tiebreaker since the plan is already topologically valid).
  const order = orderedDeps(opts.plan, opts.task);

  const sections: string[] = [];
  let totalTokens = 0;
  let truncated = false;
  for (const depId of order) {
    const path = join(resolve(opts.runDir), depId, 'context.md');
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, 'utf8');
    const trimmed = trimToTokenBudget(raw, perDep);
    if (trimmed.truncated) truncated = true;
    sections.push(`### task: ${depId} (completed)\n\n${trimmed.text}`);
    totalTokens += approxTokens(trimmed.text);
    if (totalTokens > total) {
      // Drop oldest (first) sections until under the cap.
      while (totalTokens > total && sections.length > 1) {
        const dropped = sections.shift();
        if (dropped) totalTokens -= approxTokens(dropped);
        truncated = true;
      }
    }
  }
  if (sections.length === 0) return { prefix: '', truncated };

  const prefix = `## Context from prior tasks\n\n${sections.join('\n\n')}${truncated ? '\n\n_(some upstream context was truncated to fit the token budget)_\n' : ''}\n\n---\n\n`;
  return { prefix, truncated };
}

function orderedDeps(plan: ResolvedPlan, task: ResolvedTask): string[] {
  const planIndex = new Map(plan.tasks.map((t, i) => [t.id, i]));
  return task.depends.slice().sort((a, b) => {
    const ia = planIndex.get(a) ?? 0;
    const ib = planIndex.get(b) ?? 0;
    if (ia !== ib) return ia - ib;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** Approximate Anthropic-style tokens at 4 chars/token. Cheap, deterministic. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function trimToTokenBudget(text: string, budget: number): { text: string; truncated: boolean } {
  const tokens = approxTokens(text);
  if (tokens <= budget) return { text, truncated: false };
  const charBudget = budget * 4;
  return { text: text.slice(0, charBudget) + '\n\n_(truncated)_', truncated: true };
}
