import type {
  AgentBackend,
  AgentEvent,
  AgentName,
  AgentProcess,
  AgentResult,
  AvailabilityReport,
  SpawnOptions,
} from '../backend.js';
import { EventQueue, nowIso } from '../backend.js';
import { ApiToolLoopBudgetError, ApiKeyMissingError } from '../../log/errors.js';
import { ToolSandbox } from './sandbox.js';
import type {
  ApiProvider,
  ApiProviderConfig,
  ApiRunRequest,
  ApiToolCall,
  ApiToolResult,
  AssistantStep,
} from './provider.js';

export interface ApiBackendOptions {
  provider: ApiProvider;
  /** Resolved API key (already env-expanded). Undefined → backend reports unavailable. */
  apiKey?: string;
  baseUrl?: string;
  /** Tool-call budget per spawn. Default 50. */
  toolBudget?: number;
}

const TOOL_DEFINITIONS = [
  {
    name: 'read_file',
    description: 'Read a file in the worktree.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file in the worktree.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, contents: { type: 'string' } },
      required: ['path', 'contents'],
    },
  },
  {
    name: 'apply_patch',
    description: 'Apply a unified diff to the worktree.',
    inputSchema: { type: 'object', properties: { diff: { type: 'string' } }, required: ['diff'] },
  },
  {
    name: 'list_files',
    description: 'List files matching an optional glob.',
    inputSchema: { type: 'object', properties: { glob: { type: 'string' } } },
  },
  {
    name: 'run_shell',
    description: 'Run a shell command in the worktree.',
    inputSchema: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
  },
];

export class ApiBackend implements AgentBackend {
  readonly name: AgentName = 'api';
  constructor(private readonly opts: ApiBackendOptions) {}

  async isAvailable(): Promise<AvailabilityReport> {
    if (!this.opts.apiKey) {
      return {
        available: false,
        reason: `provider '${this.opts.provider.name}' has no API key`,
      };
    }
    return this.opts.provider.isAvailable({ apiKey: this.opts.apiKey, baseUrl: this.opts.baseUrl });
  }

  async spawn(spawnOpts: SpawnOptions): Promise<AgentProcess> {
    if (!this.opts.apiKey) {
      throw new ApiKeyMissingError({
        message: `agent: api requested but provider '${this.opts.provider.name}' has no key`,
        provider: this.opts.provider.name,
      });
    }

    const queue = new EventQueue<AgentEvent>();
    const start = Date.now();
    const sandbox = new ToolSandbox({ cwd: spawnOpts.cwd });
    const budget = this.opts.toolBudget ?? 50;
    let stdout = '';
    let toolUseCount = 0;
    let resolveResult!: (r: AgentResult) => void;
    let rejectResult!: (e: Error) => void;
    const completed = new Promise<AgentResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    const finalSystem = [spawnOpts.systemPrompt, ...(spawnOpts.skills ?? []).map((s) => `[skill: ${s}]`)]
      .filter(Boolean)
      .join('\n');
    const model = spawnOpts.api?.model ?? spawnOpts.model ?? '';

    void (async () => {
      try {
        const history: AssistantStep[] = [];
        let pendingToolResults: ApiToolResult[] | undefined;
        for (let iter = 0; iter < budget + 1; iter++) {
          if (iter === budget) {
            throw new ApiToolLoopBudgetError({
              message: `tool-loop budget of ${budget} exceeded`,
              limit: budget,
            });
          }
          const step = await this.opts.provider.step({
            systemPrompt: finalSystem,
            prompt: spawnOpts.prompt,
            model,
            tools: TOOL_DEFINITIONS,
            toolResults: pendingToolResults,
            prevAssistantMessages: history,
            ...(spawnOpts.signal ? { signal: spawnOpts.signal } : {}),
            ...(this.opts.apiKey ? { apiKey: this.opts.apiKey } : {}),
            ...(this.opts.baseUrl ? { baseUrl: this.opts.baseUrl } : {}),
          });
          history.push(step);
          if (step.text) {
            stdout += step.text;
            queue.push({ type: 'stdout', data: step.text, timestamp: nowIso() });
          }
          if (step.toolCalls.length === 0 || step.stop) {
            break;
          }
          const results: ApiToolResult[] = [];
          for (const call of step.toolCalls) {
            toolUseCount += 1;
            queue.push({
              type: 'tool-use',
              data: JSON.stringify({ name: call.name, input: call.input }),
              timestamp: nowIso(),
            });
            results.push(this.runTool(sandbox, call));
          }
          // Attach the tool results to the step they came from. Providers
          // reconstructing a multi-turn conversation read these from history
          // — Anthropic requires every `tool_use` to be followed by a
          // matching `tool_result` in the very next user turn.
          step.toolResults = results;
          pendingToolResults = results;
        }
        queue.finish();
        resolveResult({
          exitCode: 0,
          stdout,
          stderr: '',
          toolUseCount,
          mcpToolCalls: [],
          durationMs: Date.now() - start,
        });
      } catch (err) {
        queue.finish();
        rejectResult(err as Error);
      }
    })();

    return {
      pid: 0,
      events: queue,
      completed,
      cancel: async () => {
        queue.finish();
      },
    };
  }

  private runTool(sandbox: ToolSandbox, call: ApiToolCall): ApiToolResult {
    try {
      const input = (call.input ?? {}) as Record<string, unknown>;
      switch (call.name) {
        case 'read_file': {
          const out = sandbox.readFile(String(input['path'] ?? ''));
          return { id: call.id, content: out };
        }
        case 'write_file': {
          const r = sandbox.writeFile(String(input['path'] ?? ''), String(input['contents'] ?? ''));
          return { id: call.id, content: `wrote ${r.bytes} bytes` };
        }
        case 'apply_patch': {
          const r = sandbox.applyPatch(String(input['diff'] ?? ''));
          return { id: call.id, content: `patched ${r.filesChanged} file(s)` };
        }
        case 'list_files': {
          const files = sandbox.listFiles(input['glob'] ? String(input['glob']) : undefined);
          return { id: call.id, content: files.join('\n') };
        }
        case 'run_shell': {
          const r = sandbox.runShell(String(input['cmd'] ?? ''));
          return {
            id: call.id,
            content: `exit ${r.exitCode}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`,
          };
        }
        default:
          return { id: call.id, content: `unknown tool: ${call.name}`, isError: true };
      }
    } catch (err) {
      return { id: call.id, content: (err as Error).message, isError: true };
    }
  }
}

/**
 * Anthropic Messages-API provider. Uses native `fetch` (Node 20+, no SDK
 * dependency), POSTs to `/v1/messages`, threads the multi-turn tool-use
 * conversation through history. Supports cancellation via `AbortSignal`.
 *
 * The transport is intentionally small — Anthropic's API surface only needs
 * one endpoint, one auth header, and a stable schema. Adding `@anthropic-
 * ai/sdk` would add ~120 KB and an extra abstraction layer for very little
 * benefit at this call site.
 */
export class AnthropicProvider implements ApiProvider {
  readonly name = 'anthropic' as const;

  constructor(
    private readonly opts: {
      /** Override the global fetch (for tests). */
      fetchFn?: typeof fetch;
      /** Cap on Anthropic max_tokens per request. Default 4096. */
      maxTokens?: number;
    } = {},
  ) {}

  isAvailable(config: ApiProviderConfig): { available: boolean; reason?: string } {
    if (!config.apiKey) return { available: false, reason: 'no ANTHROPIC_API_KEY configured' };
    return { available: true };
  }

  async step(req: ApiRunRequest): Promise<AssistantStep> {
    const fetchImpl = this.opts.fetchFn ?? fetch;
    const baseUrl = req.baseUrl ?? 'https://api.anthropic.com';
    // The provider reads apiKey/baseUrl from the request to keep the
    // provider-level constructor stateless across spawns. ApiBackend resolves
    // the env-expanded values before each step and threads them through.
    if (!req.apiKey) throw new Error('AnthropicProvider.step called without apiKey on request');
    const apiKey = req.apiKey;

    // Reconstruct the conversation. Anthropic's `tool_use` blocks must be
    // followed by `tool_result` blocks in the very next user turn — that's
    // why AssistantStep.toolResults is populated by ApiBackend before the
    // next step() call.
    const messages: AnthropicMessage[] = [{ role: 'user', content: req.prompt }];
    for (const prev of req.prevAssistantMessages ?? []) {
      const assistantContent: AnthropicContentBlock[] = [];
      if (prev.text) assistantContent.push({ type: 'text', text: prev.text });
      for (const tc of prev.toolCalls) {
        assistantContent.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: (tc.input ?? {}) as Record<string, unknown>,
        });
      }
      messages.push({ role: 'assistant', content: assistantContent });
      if (prev.toolResults && prev.toolResults.length > 0) {
        messages.push({
          role: 'user',
          content: prev.toolResults.map((tr) => ({
            type: 'tool_result' as const,
            tool_use_id: tr.id,
            content: tr.content,
            ...(tr.isError ? { is_error: true } : {}),
          })),
        });
      }
    }

    // F14.3 — Prompt caching. We set three cache breakpoints:
    //  1. The system prompt (stable across every step in a spawn).
    //  2. The last tool in the tools array (marks the whole tools list).
    //  3. The most recent tool_result block in messages (marks the
    //     accumulating conversation prefix so step N+1 reuses step N's
    //     cache).
    // Anthropic permits up to 4 breakpoints per request; we use 3 with one
    // slot held in reserve. TTL is ephemeral (5 minutes), good enough for
    // a single task spawn.
    const cacheControl = { type: 'ephemeral' as const };
    const systemBlocks: { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[] = [
      { type: 'text', text: req.systemPrompt },
    ];
    if (systemBlocks.length > 0 && systemBlocks[0]) {
      systemBlocks[systemBlocks.length - 1] = {
        ...(systemBlocks[systemBlocks.length - 1] as { type: 'text'; text: string }),
        cache_control: cacheControl,
      };
    }
    const tools = req.tools.map((t, i, arr) => {
      const base = {
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      };
      // Mark the LAST tool as the cache breakpoint for the entire tools
      // array. Subsequent requests with the same tools list re-use the
      // cached tokens; a tools-list change invalidates the breakpoint.
      return i === arr.length - 1
        ? { ...base, cache_control: cacheControl }
        : base;
    });
    // Mark the last tool_result block in the most recent user-turn as the
    // conversation cache breakpoint. Anthropic caches everything UP TO and
    // INCLUDING the marker, so step N+1 sees step N's tool result in cache.
    markLastToolResultCacheControl(messages, cacheControl);

    const body = {
      model: req.model,
      max_tokens: this.opts.maxTokens ?? 4096,
      system: systemBlocks,
      messages,
      tools,
    };

    const resp = await fetchImpl(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      ...(req.signal ? { signal: req.signal } : {}),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      // Surface enough of the error body for debugging without leaking the
      // request payload (which contains the system prompt and any prior
      // tool outputs).
      throw new Error(
        `anthropic ${resp.status}: ${text.slice(0, 500) || resp.statusText}`,
      );
    }
    const parsed = (await resp.json()) as AnthropicResponse;
    let text = '';
    const toolCalls: ApiToolCall[] = [];
    for (const block of parsed.content ?? []) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, input: block.input });
      }
    }
    const stop = parsed.stop_reason !== 'tool_use';
    const usage = parsed.usage
      ? {
          ...(parsed.usage.input_tokens !== undefined ? { inputTokens: parsed.usage.input_tokens } : {}),
          ...(parsed.usage.output_tokens !== undefined ? { outputTokens: parsed.usage.output_tokens } : {}),
          ...(parsed.usage.cache_creation_input_tokens !== undefined
            ? { cacheCreation: parsed.usage.cache_creation_input_tokens }
            : {}),
          ...(parsed.usage.cache_read_input_tokens !== undefined
            ? { cacheRead: parsed.usage.cache_read_input_tokens }
            : {}),
        }
      : undefined;
    const step: AssistantStep = { text, toolCalls, stop };
    if (usage !== undefined) step.usage = usage;
    return step;
  }
}

/**
 * Walk `messages` from the end backwards and mark the most recent
 * `tool_result` block (or the last block of the most recent user turn if
 * none) with the supplied `cache_control` marker. No-op when messages is
 * empty. Mutates in place because the message array is local to the request
 * builder and disposed after the fetch.
 */
function markLastToolResultCacheControl(
  messages: AnthropicMessage[],
  cacheControl: { type: 'ephemeral' },
): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user' || typeof m.content === 'string') continue;
    // Prefer marking the last tool_result block; fall back to the last block.
    for (let j = m.content.length - 1; j >= 0; j--) {
      const b = m.content[j];
      if (b && b.type === 'tool_result') {
        (b as AnthropicContentBlock & { cache_control?: { type: 'ephemeral' } }).cache_control =
          cacheControl;
        return;
      }
    }
    const last = m.content[m.content.length - 1];
    if (last) {
      (last as AnthropicContentBlock & { cache_control?: { type: 'ephemeral' } }).cache_control =
        cacheControl;
      return;
    }
  }
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicResponse {
  content: AnthropicContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export class OpenAIProvider implements ApiProvider {
  readonly name = 'openai' as const;
  isAvailable(): { available: boolean; reason?: string } {
    return { available: false, reason: 'openai provider SDK integration is post-MVP' };
  }
  async step(): Promise<AssistantStep> {
    throw new Error('OpenAIProvider not yet implemented');
  }
}
export class OpenRouterProvider implements ApiProvider {
  readonly name = 'openrouter' as const;
  isAvailable(): { available: boolean; reason?: string } {
    return { available: false, reason: 'openrouter provider SDK integration is post-MVP' };
  }
  async step(): Promise<AssistantStep> {
    throw new Error('OpenRouterProvider not yet implemented');
  }
}
