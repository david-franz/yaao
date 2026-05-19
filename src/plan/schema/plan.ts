import { z } from 'zod';
import { AgentNameSchema } from '../../config/schema.js';

const SLUG_RE = /^[a-z][a-z0-9-_]*$/;

export const DurationSchema = z
  .string()
  .regex(/^[0-9]+(ms|s|m|h)$/, { message: 'duration must look like 30s, 5m, 2h, or 500ms' });

export const ApiBindingSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'openrouter']),
  model: z.string().min(1),
  'base-url': z.string().url().optional(),
});

export const ValidationSchema = z.object({
  command: z.string().min(1).optional(),
  'must-pass': z.boolean().default(true),
  /** Subdirectory of the worktree to run the validation command in. Useful
   * for monorepos where a task owns one workspace but the worktree root holds
   * the whole repo. Relative paths only; resolved against the worktree root. */
  cwd: z.string().optional(),
});

export const PermissionModeSchema = z.enum(['ask', 'allow-edits', 'allow-all']);

/**
 * Shell command run after a task's main validation as a cross-cutting check
 * (typecheck, lint, project-wide tests). Same shape as ValidationSchema so
 * the lifecycle treats hook failures the same as validation failures —
 * including the retry-with-context loop.
 */
export const HookSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  'must-pass': z.boolean().default(true),
});

export const MergeStrategySchema = z.enum(['auto', 'pr', 'manual', 'none']);

/**
 * Per-task merge directive. Shorthand form is the strategy string; the object
 * form additionally lets a plan author route a task's commits into a specific
 * branch (e.g. a phase branch) after the task completes.
 */
export const TaskMergeObjectSchema = z
  .object({
    strategy: MergeStrategySchema.optional(),
    /** Branch to merge this task's commits into after it completes. */
    into: z.string().optional(),
    /** When to perform the merge. 'manual' leaves the branch for the user. */
    when: z.enum(['completed', 'manual']).default('completed'),
    /** If `into` doesn't exist, create it from base-branch before merging. */
    'create-if-missing': z.boolean().default(true),
  })
  .strict();

export const TaskMergeSchema = z.union([MergeStrategySchema, TaskMergeObjectSchema]);

export const TaskContextSchema = z.object({
  'ctx-sys': z
    .object({
      enabled: z.boolean().optional(),
      'require-query': z.boolean().optional(),
      /** When false, suppresses the advisory ctx-sys directive for this task (F7.3). */
      directive: z.boolean().optional(),
    })
    .optional(),
});

export const TaskSchema = z
  .object({
    id: z.string().regex(SLUG_RE, { message: 'task id must be a slug (a-z0-9-_)' }),
    title: z.string().min(1),
    description: z.string().optional(),
    prompt: z.string().optional(),
    'prompt-ref': z.string().optional(),
    depends: z.array(z.string()).default([]),
    agent: AgentNameSchema,
    model: z.string().optional(),
    api: ApiBindingSchema.optional(),
    skills: z.array(z.string()).default([]),
    files: z.array(z.string()).default([]),
    branch: z.string().optional(),
    worktree: z.string().optional(),
    timeout: DurationSchema.optional(),
    // Default to 1: a single auto-retry catches the common class of flaky
    // validation failures (test teardown not closing handles, transient
    // network/install errors, the agent picking the wrong API version) and
    // re-spawns the agent with the captured failure context injected into
    // the prompt — usually enough for the agent to self-correct. Set to 0
    // when you want fail-fast behaviour for debugging.
    retries: z.number().int().min(0).default(1),
    validation: ValidationSchema.optional(),
    merge: TaskMergeSchema.optional(),
    context: TaskContextSchema.optional(),
    env: z.record(z.string()).default({}),
    /** Shell commands run inside the worktree before spawning the agent.
     * Use for environment bootstrap (e.g. `pnpm install`, `docker compose up -d postgres`).
     * Each command runs sequentially via `sh -c`; failures fail the task. */
    setup: z.array(z.string()).default([]),
    /** Override the per-agent permission mode for this task. */
    permissions: PermissionModeSchema.optional(),
    /** When false, the lifecycle does NOT prepend `context.md` summaries from
     * this task's deps onto the prompt. Default true — most tasks benefit
     * from the upstream story; e2e/integration tasks that only need the code
     * (already merged in from dep branches) can opt out to save prompt budget. */
    'inherit-dep-context': z.boolean().optional(),
  })
  .strict()
  .refine(
    (t) => Boolean(t.prompt) !== Boolean(t['prompt-ref']),
    { message: 'task requires exactly one of prompt or prompt-ref', path: ['prompt'] },
  )
  .refine(
    (t) => t.agent !== 'api' || Boolean(t.api),
    { message: "agent: api requires an `api:` binding", path: ['api'] },
  );

export const PlanConfigSchema = z
  .object({
    'base-branch': z.string().optional(),
    'max-parallel': z.number().int().positive().optional(),
    'worktree-root': z.string().optional(),
    merge: z
      .object({
        strategy: z.enum(['auto', 'pr', 'manual']).optional(),
        'on-conflict': z.enum(['manual', 'agent']).optional(),
        /** Which git verb is used for the outgoing merge (task branch into
         * its target / base-branch). `merge` produces a merge commit;
         * `rebase` replays the task's commits on top of the target for a
         * linear history. Default `merge`. */
        history: z.enum(['merge', 'rebase']).optional(),
      })
      .strict()
      .optional(),
    /** Token budgets for the upstream-context preamble prepended to a task's
     * prompt. Both are approximate (4 chars/token). When omitted, the lifecycle
     * uses sensible defaults (2000 per dep, 12000 total). */
    context: z
      .object({
        'per-dep-budget': z.number().int().positive().optional(),
        'total-budget': z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    /** Plan-wide hooks. `post-task` commands run after every task's own
     * validation succeeds and before the lifecycle commits the task's work.
     * Use for cross-cutting checks like `typecheck`, `lint`, project-wide
     * `test`. Each entry has the same shape as `validation`: { command, cwd?,
     * must-pass? }. A failing must-pass hook fails the task and triggers the
     * retry-with-context flow. */
    hooks: z
      .object({
        'post-task': z.array(HookSchema).default([]),
      })
      .strict()
      .optional(),
  })
  .strict();

export const PlanContextSchema = z
  .object({
    'ctx-sys': z
      .object({
        enabled: z.boolean().optional(),
        'require-query': z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const PlanHeaderSchema = z
  .object({
    name: z.string().regex(SLUG_RE, { message: 'plan.name must be a slug' }),
    version: z.literal(1),
    description: z.string().optional(),
    /**
     * Per-plan integration branch. When set, the run creates it from
     * `base-branch` if missing, routes layer-0 task branches off it, and
     * auto-merges task work into it instead of `base-branch`. Absent →
     * tasks merge straight into the workspace base-branch.
     */
    featureBranch: z.string().min(1).optional(),
  })
  .strict();

export const PlanSchema = z
  .object({
    plan: PlanHeaderSchema,
    config: PlanConfigSchema.optional(),
    context: PlanContextSchema.optional(),
    includes: z.array(z.string()).default([]),
    tasks: z.array(TaskSchema).default([]),
  })
  .strict();

export type Plan = z.infer<typeof PlanSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type PlanHeader = z.infer<typeof PlanHeaderSchema>;
export type PlanConfig = z.infer<typeof PlanConfigSchema>;
export type ApiBinding = z.infer<typeof ApiBindingSchema>;
