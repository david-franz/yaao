import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { VERSION } from '../version.js';
import type { YaaoConfig } from '../config/types.js';
import {
  yaaoPlanTool,
  yaaoConvertTool,
  yaaoValidateTool,
  yaaoRunTool,
  yaaoStatusTool,
  yaaoAgentsTool,
  yaaoPlansTool,
  yaaoInspectTool,
  yaaoPruneTool,
  yaaoSkillTool,
  discoverSkills,
  type ToolContext,
  type ToolCallResult,
} from './tools.js';

export interface ServeOptions {
  cwd: string;
  config: YaaoConfig;
  transport?: 'stdio';
}

type SdkResult = {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
} & { [key: string]: unknown };

function asSdkResult(r: ToolCallResult): SdkResult {
  return {
    content: [{ type: 'text' as const, text: r.text }],
    structuredContent: r.structuredContent,
  };
}

/**
 * Build the McpServer with every yaao tool registered. Exposed separately from the
 * transport so tests can drive the server in-process.
 */
export function buildMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: 'yaao', version: VERSION });

  server.registerTool(
    'yaao_plan',
    {
      description: 'Generate an implementation plan for a feature or project',
      inputSchema: {
        description: z.string(),
        scope: z.enum(['feature', 'project']).optional(),
        format: z.enum(['markdown', 'speckit', 'both']).optional(),
        out: z.string().optional(),
        agent: z.enum(['claude-code', 'cursor', 'copilot', 'codex', 'api']).optional(),
      },
    },
    async (args) => asSdkResult(await yaaoPlanTool(args, ctx)),
  );

  server.registerTool(
    'yaao_convert',
    {
      description: 'Convert a markdown or Spec Kit plan into a schema-valid execution YAML',
      inputSchema: {
        input: z.string(),
        out: z.string().optional(),
        inferDeps: z.enum(['off', 'suggest', 'auto']).optional(),
      },
    },
    async (args) => asSdkResult(await yaaoConvertTool(args, ctx)),
  );

  server.registerTool(
    'yaao_validate',
    {
      description: 'Validate an execution plan against the schema and DAG checks',
      inputSchema: { plan: z.string() },
    },
    async (args) => asSdkResult(await yaaoValidateTool(args, ctx)),
  );

  server.registerTool(
    'yaao_run',
    {
      description: 'Start an execution plan run across worktrees',
      inputSchema: {
        plan: z.string(),
        only: z.array(z.string()).optional(),
        skip: z.array(z.string()).optional(),
        trial: z.boolean().optional(),
        noMerge: z
          .boolean()
          .optional()
          .describe(
            'Skip the post-task auto-merge — tasks land on their own branches only. Use when you want to review or PR before landing on base-branch.',
          ),
      },
    },
    async (args) => asSdkResult(await yaaoRunTool(args, ctx)),
  );

  server.registerTool(
    'yaao_status',
    {
      description: 'Inspect a previous or in-flight run',
      inputSchema: { runId: z.string().optional() },
    },
    async (args) => asSdkResult(await yaaoStatusTool(args, ctx)),
  );

  server.registerTool(
    'yaao_agents',
    {
      description: 'List detected agent backends and their availability',
      inputSchema: {},
    },
    async () => asSdkResult(await yaaoAgentsTool({}, ctx)),
  );

  server.registerTool(
    'yaao_plans',
    {
      description: 'List discoverable implementation plans and execution plans',
      inputSchema: {},
    },
    async () => asSdkResult(await yaaoPlansTool({}, ctx)),
  );

  server.registerTool(
    'yaao_inspect',
    {
      description:
        'One-call workspace snapshot: workspace config, every plan + exec pair (with git-tracked status, mtime, hash, planCommit), and every run (status, task counts, branchesAlive). Pair with yaao_prune({dryRun: true}) for "see and preview".',
      inputSchema: {
        slug: z
          .string()
          .optional()
          .describe('Restrict to a single plan slug (filename without extension); omit for the full workspace.'),
      },
    },
    async (args) => asSdkResult(await yaaoInspectTool(args, ctx)),
  );

  server.registerTool(
    'yaao_prune',
    {
      description:
        'Structured cleanup of yaao state. Targets one run, one plan, or all completed/failed/older-than runs, and removes some scope (worktrees, branches, runs). dryRun defaults to true — pass dryRun: false to actually mutate. Refuses to delete the configured base-branch, worktrees with uncommitted changes, or branches not merged into their target unless force: true.',
      inputSchema: {
        target: z.enum(['run', 'plan', 'all-completed', 'all-failed', 'older-than']),
        runId: z.string().optional(),
        planSlug: z.string().optional(),
        olderThanDays: z.number().optional(),
        scope: z.array(z.enum(['worktrees', 'branches', 'runs'])).optional(),
        dryRun: z.boolean().optional().describe('Default true — preview only.'),
        force: z
          .boolean()
          .optional()
          .describe('Required to remove worktrees with uncommitted changes or branches not yet merged.'),
      },
    },
    async (args) => asSdkResult(await yaaoPruneTool(args, ctx)),
  );

  // F12.5: auto-register every discoverable skill as `yaao_skill_<name>`.
  for (const skill of discoverSkills(ctx)) {
    const inputShape: Record<string, z.ZodTypeAny> = {};
    for (const input of skill.inputs) {
      const base = z.string().describe(input.description ?? '');
      inputShape[input.name] = input.required ? base : base.optional();
    }
    server.registerTool(
      `yaao_skill_${skill.name}`,
      {
        description: skill.description,
        inputSchema: inputShape,
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async (args) =>
        asSdkResult(yaaoSkillTool(skill.name, args as Record<string, string | undefined>, ctx)),
    );
  }

  return server;
}

export async function serve(opts: ServeOptions): Promise<void> {
  const server = buildMcpServer({ cwd: opts.cwd, config: opts.config });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Block until the transport closes (parent process disconnects).
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
}
