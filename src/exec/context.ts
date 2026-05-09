import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ResolvedPlan, ResolvedTask } from '../plan/schema/types.js';

export interface ContextDirOptions {
  runDir: string;
}

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
}

export const DEFAULT_PER_DEP_TOKEN_BUDGET = 2000;
export const DEFAULT_TOTAL_TOKEN_BUDGET = 12_000;

export function writeContextMd(
  runDir: string,
  task: ResolvedTask,
  artifact: TaskOutcomeArtifact,
): string {
  const dir = join(runDir, task.id);
  mkdirSync(dir, { recursive: true });
  const summaryLines = artifact.summary.trim().split(/\r?\n/);
  const lastN = summaryLines.slice(-80).join('\n');

  const fileList = artifact.files
    .map((f) => `- \`${f.path}\` (${f.status})`)
    .join('\n');

  const md = `# ${task.id} — ${task.title}

**Branch**: ${artifact.branch}
**Files changed**: ${artifact.filesChanged} (+${artifact.insertions} / -${artifact.deletions})

## Summary

${lastN}

## Files

${fileList || '_(none)_'}

## Commit

${artifact.commit ? `${artifact.commit.slice(0, 7)} ${artifact.commitSubject ?? task.title}` : '_(no commit)_'}
`;

  const path = join(dir, 'context.md');
  writeFileSync(path, md);
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
