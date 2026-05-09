import type { AgentName as ConfigAgentName } from '../config/types.js';

export type AgentName = ConfigAgentName;

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpToolCall {
  server: string;
  tool: string;
  input?: unknown;
  ok: boolean;
  durationMs?: number;
}

export interface SpawnOptions {
  cwd: string;
  prompt: string;
  systemPrompt?: string;
  model?: string;
  skills?: string[];
  mcpServers?: McpServerConfig[];
  env?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
  /** Provider/model binding for the API backend; ignored by CLI backends. */
  api?: { provider: 'anthropic' | 'openai' | 'openrouter'; model: string; baseUrl?: string };
}

export interface AgentEvent {
  type: 'stdout' | 'stderr' | 'tool-use' | 'thinking';
  data: string;
  timestamp: string;
}

export interface AgentResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  toolUseCount: number;
  mcpToolCalls: McpToolCall[];
  durationMs: number;
}

export interface AgentProcess {
  pid?: number;
  events: AsyncIterable<AgentEvent>;
  completed: Promise<AgentResult>;
  cancel(reason?: string): Promise<void>;
}

export interface AvailabilityReport {
  available: boolean;
  version?: string;
  reason?: string;
}

export interface AgentBackend {
  readonly name: AgentName;
  isAvailable(): Promise<AvailabilityReport>;
  spawn(opts: SpawnOptions): Promise<AgentProcess>;
}

/** Helper for emitting events to a queue and exposing them as an async iterable. */
export class EventQueue<T> implements AsyncIterable<T> {
  private readonly resolvers: Array<(v: IteratorResult<T>) => void> = [];
  private readonly buffer: T[] = [];
  private done = false;

  push(v: T): void {
    if (this.done) return;
    const r = this.resolvers.shift();
    if (r) r({ value: v, done: false });
    else this.buffer.push(v);
  }

  finish(): void {
    this.done = true;
    for (const r of this.resolvers) r({ value: undefined as unknown as T, done: true });
    this.resolvers.length = 0;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const v = this.buffer.shift();
        if (v !== undefined) return Promise.resolve({ value: v, done: false });
        if (this.done) return Promise.resolve({ value: undefined as unknown as T, done: true });
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
