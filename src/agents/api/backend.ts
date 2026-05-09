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
import type { ApiProvider, ApiToolCall, ApiToolResult, AssistantStep } from './provider.js';

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
            signal: spawnOpts.signal,
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

/** Stub real-provider classes — full SDK integration lands later. */
export class AnthropicProvider implements ApiProvider {
  readonly name = 'anthropic' as const;
  isAvailable(): { available: boolean; reason?: string } {
    return { available: false, reason: 'anthropic provider SDK integration is post-MVP' };
  }
  async step(): Promise<AssistantStep> {
    throw new Error('AnthropicProvider not yet implemented');
  }
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
