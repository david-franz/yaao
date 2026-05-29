export type ApiProviderName = 'anthropic' | 'openai' | 'openrouter';

export interface ApiToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ApiToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ApiToolResult {
  id: string;
  content: string;
  isError?: boolean;
}

export interface ApiRunRequest {
  systemPrompt: string;
  prompt: string;
  model: string;
  tools: ApiToolDefinition[];
  toolResults?: ApiToolResult[];
  prevAssistantMessages?: AssistantStep[];
  signal?: AbortSignal;
  /**
   * Resolved API key + optional base URL. Read by network-backed providers
   * (AnthropicProvider, OpenAIProvider, etc.). Threaded through per-request
   * rather than held on the provider instance so a single provider can be
   * reused across calls with different credentials and so the credentials
   * never live in long-lived process state.
   */
  apiKey?: string;
  baseUrl?: string;
}

export interface AssistantStep {
  text: string;
  toolCalls: ApiToolCall[];
  /** True if the model decided to stop without further tool calls. */
  stop: boolean;
  /**
   * Tool results the backend produced from `toolCalls` AFTER this step
   * completed and fed back into the next iteration. Providers reconstructing
   * the multi-turn message history (e.g. Anthropic's `tool_result` blocks
   * must immediately follow the assistant turn that emitted the `tool_use`)
   * read these from `prevAssistantMessages` rather than only the latest
   * `toolResults` field on the next request. Populated by the ApiBackend
   * loop, not by providers.
   */
  toolResults?: ApiToolResult[];
  /**
   * Cache + token usage for this step, when the provider surfaces it.
   * Anthropic returns `cache_creation_input_tokens` / `cache_read_input_tokens`
   * on every response when the request used `cache_control` markers; OpenAI's
   * automatic caching returns `usage.prompt_tokens_details.cached_tokens`.
   * Both are normalized to a flat shape here so the lifecycle / journal /
   * web viewer can accumulate them uniformly. Undefined when the provider
   * doesn't surface usage (e.g. the FakeApiProvider used in tests).
   */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    /** Tokens written to a fresh cache breakpoint on this request. */
    cacheCreation?: number;
    /** Tokens served from cache on this request. */
    cacheRead?: number;
  };
}

export interface ApiProviderConfig {
  apiKey?: string;
  baseUrl?: string;
}

export interface ApiProvider {
  readonly name: ApiProviderName;
  isAvailable(config: ApiProviderConfig): { available: boolean; reason?: string };
  /**
   * One step in the tool-use loop: send the request, receive an assistant message
   * with optional tool calls. The caller runs the tools and feeds results back via
   * `prevAssistantMessages` + `toolResults` until `stop: true`.
   */
  step(req: ApiRunRequest): Promise<AssistantStep>;
}
