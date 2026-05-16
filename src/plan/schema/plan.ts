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
    retries: z.number().int().min(0).default(0),
    validation: ValidationSchema.optional(),
    merge: TaskMergeSchema.optional(),
    context: TaskContextSchema.optional(),
    env: z.record(z.string()).default({}),
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
