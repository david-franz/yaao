import { z } from 'zod';

export const AGENT_NAMES = ['claude-code', 'cursor', 'copilot', 'codex', 'api'] as const;
export const AgentNameSchema = z.enum(AGENT_NAMES);

const ApiProviderSchema = z.object({
  'api-key': z.string(),
  'base-url': z.string().url().optional(),
});

export const ConfigSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1),
    defaults: z
      .object({
        agent: AgentNameSchema.default('claude-code'),
        model: z.string().default('opus'),
        'max-parallel': z.number().int().positive().default(4),
        'base-branch': z.string().default('main'),
        'worktree-root': z.string().default('.yaao/worktrees'),
        /** Default permission mode for tasks. `allow-all` lets non-interactive
         * agents run shell commands (e.g. `pnpm install`) without prompting.
         * Per-task `permissions:` overrides this. */
        permissions: z.enum(['ask', 'allow-edits', 'allow-all']).default('allow-all'),
      })
      .default({}),
    merge: z
      .object({
        strategy: z.enum(['auto', 'pr', 'manual']).default('auto'),
        // Default to 'agent': dep-branch merge conflicts (the common shape when
        // parallel sibling tasks touch overlapping files) get resolved inline
        // by the executing agent instead of failing the task. Set to 'manual'
        // to get the historical behaviour of aborting + failing the task.
        'on-conflict': z.enum(['manual', 'agent']).default('agent'),
        // Which git verb to use when landing a task branch on its target
        // (auto-merge to base-branch, or task.merge.into). `merge` produces a
        // merge commit per task; `rebase` replays commits for linear history.
        history: z.enum(['merge', 'rebase']).default('merge'),
        'conflict-resolver': z
          .object({ agent: AgentNameSchema, model: z.string() })
          .optional(),
      })
      .default({}),
    agents: z
      .object({
        // Per-agent `default-model` overrides `defaults.model` when this agent
        // is the one assigned to the task. Lets you say "use sonnet on
        // claude-code but opus on the API backend" without per-task model
        // declarations in the plan.
        'claude-code': z
          .object({
            enabled: z.boolean().default(true),
            bin: z.string().default('claude'),
            'default-model': z.string().optional(),
          })
          .default({}),
        cursor: z
          .object({
            enabled: z.boolean().default(true),
            bin: z.string().default('cursor-agent'),
            'default-model': z.string().optional(),
          })
          .default({}),
        copilot: z
          .object({
            enabled: z.boolean().default(true),
            bin: z.string().default('gh'),
            'default-model': z.string().optional(),
          })
          .default({}),
        codex: z
          .object({
            enabled: z.boolean().default(true),
            bin: z.string().default('codex'),
            'default-model': z.string().optional(),
          })
          .default({}),
        api: z
          .object({
            providers: z.record(ApiProviderSchema).default({}),
            'default-model': z.string().optional(),
          })
          .default({}),
      })
      .default({}),
    'ctx-sys': z
      .object({
        enabled: z.boolean().default(false),
        'auto-spawn': z.boolean().default(true),
        'require-query': z.boolean().default(false),
      })
      .default({}),
    plan: z
      .object({
        format: z.enum(['markdown', 'speckit', 'both']).default('markdown'),
        speckit: z.boolean().default(false),
        /** Default directory `yaao plan` writes generated plans to. Override per
         * invocation with `--out`. Relative paths resolve against the project root. */
        'out-dir': z.string().default('.yaao/plans'),
        /** Default directory `yaao convert` writes execution YAML to. Override with `--out`. */
        'exec-dir': z.string().default('.yaao/exec'),
      })
      .default({}),
    run: z
      .object({
        /**
         * Gate on `yaao run` when the plan file isn't recorded in git. Stops
         * a run from leaving merged commits on main whose source-of-truth plan
         * is sitting untracked in the working tree — the audit trail problem
         * the original feedback was about.
         *
         * - `error` (default): refuse to start with a clear hint.
         * - `warn`: log a warning and continue.
         * - `off`: skip the check entirely.
         */
        'require-tracked-plan': z.enum(['error', 'warn', 'off']).default('error'),
      })
      .default({}),
    convert: z
      .object({
        /** Project-level agent-routing rules consulted by `yaao convert`. User
         * rules take precedence over the built-in catch-all rules. */
        'agent-rules': z
          .array(
            z.object({
              match: z.object({
                'title-regex': z.string().optional(),
                'id-regex': z.string().optional(),
                'files-glob': z.string().optional(),
                'prompt-contains': z.string().optional(),
                any: z.boolean().optional(),
              }),
              agent: AgentNameSchema,
              model: z.string().optional(),
            }),
          )
          .default([]),
        /** Turn off the shipped catch-all rules (test→codex, ui→cursor, infra→claude-code).
         * Useful when the user only has one backend set up and wants every task to land on it. */
        'disable-builtin-rules': z.boolean().default(false),
      })
      .default({}),
    'mcp-servers': z
      .record(
        z.object({
          command: z.string().min(1),
          args: z.array(z.string()).default([]),
          env: z.record(z.string()).default({}),
        }),
      )
      .default({}),
  })
  .strict();

export type YaaoConfig = z.infer<typeof ConfigSchema>;
export type AgentName = z.infer<typeof AgentNameSchema>;
export type ApiProvider = z.infer<typeof ApiProviderSchema>;

export const DEFAULT_CONFIG: YaaoConfig = ConfigSchema.parse({ version: 1 });
