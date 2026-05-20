import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { existsSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { VERSION } from '../version.js';
import type { YaaoConfig } from '../config/types.js';
import { loadConfig, configPaths } from '../config/loader.js';
import {
  yaaoPlanTool,
  yaaoConvertTool,
  yaaoValidateTool,
  yaaoRunTool,
  yaaoResumeTool,
  yaaoStatusTool,
  yaaoStopTool,
  yaaoAgentsTool,
  yaaoPlansTool,
  yaaoInspectTool,
  yaaoPruneTool,
  yaaoSkillTool,
  discoverSkills,
  type ToolContext,
  type ToolCallResult,
  type DiscoveredSkill,
} from './tools.js';
import { createSkillWatcher, type SkillWatcher } from './skill-watcher.js';

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
        featureBranch: z
          .string()
          .optional()
          .describe(
            'Write as plan.featureBranch in the generated YAML. Per-plan integration branch; absent → tasks merge straight into base-branch.',
          ),
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
        featureBranch: z
          .string()
          .optional()
          .describe(
            "Override plan.featureBranch for this invocation. Empty string clears it (run trunk-based). Precedence: runtime arg > plan.featureBranch > none.",
          ),
        baseBranch: z
          .string()
          .optional()
          .describe(
            'Override the workspace base-branch for this invocation. Escape hatch for testing a plan against a scratch repo state.',
          ),
      },
    },
    async (args) => asSdkResult(await yaaoRunTool(args, ctx)),
  );

  server.registerTool(
    'yaao_resume',
    {
      description:
        'Continue a prior run under the same runId. Re-runs failed / interrupted tasks; previously-completed tasks are synthesised as done without re-running. Audit trail stays continuous: one runId carries through start → fail → resume → success.',
      inputSchema: {
        runId: z.string().describe('runId of the prior run to continue.'),
        retryFailed: z
          .boolean()
          .optional()
          .describe('Re-run anything not in {completed, cached}. Default true.'),
        reskip: z
          .boolean()
          .optional()
          .describe('Leave previously-skipped tasks skipped. Default false.'),
      },
    },
    async (args) => asSdkResult(await yaaoResumeTool(args, ctx)),
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
    'yaao_stop',
    {
      description:
        "Stop a running yaao run by sending SIGTERM to its runner process. The runner's signal handler stamps `run:end status=cancelled` in the journal before exiting. Idempotent: ok=true even when the run was already not running.",
      inputSchema: { runId: z.string() },
    },
    async (args) => asSdkResult(await yaaoStopTool(args, ctx)),
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
  // F12.6: each registration is tracked so the watcher can diff against the
  // live set and add/remove handles when skills appear or vanish on disk.
  const skillHandles = new Map<string, RegisteredHandle>();
  for (const skill of discoverSkills(ctx)) {
    registerSkillAsTool(server, ctx, skill, skillHandles);
  }
  skillRegistry.set(server, { ctx, handles: skillHandles });

  return server;
}

/**
 * Handle returned by `server.registerTool` — typed loosely because the SDK
 * exposes `.remove()` (which itself sends `tools/list_changed`) but doesn't
 * publish the type. Keeping this tight to just the field we use keeps the
 * SDK coupling minimal.
 */
interface RegisteredHandle {
  remove: () => void;
}

interface SkillRegistry {
  ctx: ToolContext;
  handles: Map<string, RegisteredHandle>;
}

/**
 * WeakMap from server → its skill bookkeeping. Lives module-level so
 * `startSkillWatcher` can reach the right map from a server it was given.
 * WeakMap so a discarded server is eligible for GC.
 */
const skillRegistry = new WeakMap<McpServer, SkillRegistry>();

function registerSkillAsTool(
  server: McpServer,
  ctx: ToolContext,
  skill: DiscoveredSkill,
  handles: Map<string, RegisteredHandle>,
): void {
  const inputShape: Record<string, z.ZodTypeAny> = {};
  for (const input of skill.inputs) {
    const base = z.string().describe(input.description ?? '');
    inputShape[input.name] = input.required ? base : base.optional();
  }
  const handle = server.registerTool(
    `yaao_skill_${skill.name}`,
    {
      description: skill.description,
      inputSchema: inputShape,
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async (args) =>
      asSdkResult(yaaoSkillTool(skill.name, args as Record<string, string | undefined>, ctx)),
  ) as unknown as RegisteredHandle;
  handles.set(skill.name, handle);
}

/**
 * Reconcile the server's registered skill tools against what's currently on
 * disk. Adds tools for new skills, removes tools for skills that vanished,
 * and leaves stable ones alone. Each register / remove call also fires
 * `tools/list_changed` via the SDK so connected clients refresh.
 *
 * Exported for the watcher and for tests; production callers go through
 * {@link startSkillWatcher} which calls this on each FS change.
 */
export function reconcileSkillTools(server: McpServer): { added: string[]; removed: string[] } {
  const entry = skillRegistry.get(server);
  if (!entry) return { added: [], removed: [] };
  const live = discoverSkills(entry.ctx);
  const liveByName = new Map(live.map((s) => [s.name, s]));
  const added: string[] = [];
  const removed: string[] = [];
  for (const [name, handle] of entry.handles) {
    if (!liveByName.has(name)) {
      try {
        handle.remove();
      } catch {
        // Tool may already be torn down by another path; ignore.
      }
      entry.handles.delete(name);
      removed.push(name);
    }
  }
  for (const skill of live) {
    if (entry.handles.has(skill.name)) continue;
    try {
      registerSkillAsTool(server, entry.ctx, skill, entry.handles);
      added.push(skill.name);
    } catch {
      // Most likely a duplicate-name race or a malformed skill the discoverer
      // accepted but registerTool rejected; skip and keep going.
    }
  }
  return { added, removed };
}

export interface StartSkillWatcherOptions {
  cwd: string;
  /** Override the watcher's debounce window — tests use 0 for snappier asserts. */
  debounceMs?: number;
  /** Skip watching `~/.yaao/skills/` (tests run in tmp dirs, not the real $HOME). */
  skipUser?: boolean;
}

/**
 * Begin watching the project + user skill roots and reconcile the server's
 * tool catalog on each change. Returns the underlying SkillWatcher so the
 * caller can stop it when the transport closes.
 */
export function startSkillWatcher(server: McpServer, opts: StartSkillWatcherOptions): SkillWatcher {
  const dirs: string[] = [join(resolve(opts.cwd), '.yaao', 'skills')];
  if (!opts.skipUser) dirs.push(join(homedir(), '.yaao', 'skills'));
  const watcher = createSkillWatcher({
    dirs,
    onChange: () => reconcileSkillTools(server),
    ...(opts.debounceMs !== undefined ? { debounceMs: opts.debounceMs } : {}),
  });
  watcher.start();
  return watcher;
}

export interface StartConfigWatcherOptions {
  cwd: string;
  /** Override the debounce window. Tests use a small value for snappy asserts. */
  debounceMs?: number;
  /** Called when a reload throws (invalid edit, schema fail). Default no-op. */
  onError?: (err: Error) => void;
}

export interface ConfigWatcher {
  start(): void;
  stop(): void;
}

/**
 * Watch the project config (`yaao.config.json`) and its sibling secrets file
 * (`.yaao/secrets.local.json`) and re-load `loadConfig` on change, mutating
 * `ctx.config` in place so every subsequent tool call reads the live values.
 *
 * Tools access `ctx.config.X` at call time, so reassigning the property on
 * the shared `ctx` object propagates automatically — no per-tool plumbing
 * needed. If a reload fails (invalid JSON, schema failure), the old config
 * is preserved and `onError` is invoked.
 */
export function startConfigWatcher(ctx: ToolContext, opts: StartConfigWatcherOptions): ConfigWatcher {
  const debounceMs = opts.debounceMs ?? 100;
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  let started = false;

  // Watch each file's parent dir (more robust than watching a single path —
  // editors rename-and-replace on save, which kills a file-level watcher).
  // Filter events by basename so unrelated writes in the same dir don't fire
  // a reload.
  const paths = configPaths(resolve(ctx.cwd));
  const filesToWatch: { dir: string; basename: string }[] = [];
  if (paths.project) {
    filesToWatch.push({ dir: dirname(paths.project), basename: basename(paths.project) });
  }
  if (paths.secrets) {
    filesToWatch.push({ dir: dirname(paths.secrets), basename: basename(paths.secrets) });
  }

  const reload = async (): Promise<void> => {
    try {
      const { config } = await loadConfig({ cwd: ctx.cwd, env: process.env });
      // Mutate the shared ctx object so tool closures pick up the new value
      // on their next call. Tools read `ctx.config.X` lazily; replacing the
      // reference is enough.
      ctx.config = config;
    } catch (err) {
      // Don't crash the server on a bad edit — the user is mid-keystroke or
      // the file is briefly invalid. Keep the previous config; the next
      // valid write triggers another reload.
      if (opts.onError) opts.onError(err as Error);
    }
  };

  const fire = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void reload();
    }, debounceMs);
  };

  return {
    start() {
      if (started) return;
      started = true;
      for (const { dir, basename: bn } of filesToWatch) {
        if (!existsSync(dir)) continue;
        try {
          const w = fsWatch(dir, (_eventType, filename) => {
            // filename can be null on some platforms; in that case fire
            // anyway — the debounce coalesces any noise.
            if (filename === null || filename === bn) fire();
          });
          w.on('error', () => undefined);
          watchers.push(w);
        } catch {
          // Bad perms, vanished dir — fall through.
        }
      }
    },
    stop() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // ignore
        }
      }
      watchers.length = 0;
      started = false;
    },
  };
}

export async function serve(opts: ServeOptions): Promise<void> {
  const ctx: ToolContext = { cwd: opts.cwd, config: opts.config };
  const server = buildMcpServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // F12.6: keep the tool catalog live with on-disk skills until the
  // transport closes. The watcher tears itself down in `onclose` below.
  const skillWatcher = startSkillWatcher(server, { cwd: opts.cwd });
  // Reload yaao.config.json (+ secrets.local.json) on change so the server
  // doesn't serve a stale snapshot for the rest of its lifetime. Tools read
  // `ctx.config.X` lazily, so reassigning ctx.config inside the watcher
  // propagates to every subsequent call without per-tool plumbing.
  const configWatcher = startConfigWatcher(ctx, { cwd: opts.cwd });
  configWatcher.start();
  // Block until the transport closes (parent process disconnects).
  await new Promise<void>((res) => {
    transport.onclose = () => {
      configWatcher.stop();
      skillWatcher.stop();
      res();
    };
  });
}
