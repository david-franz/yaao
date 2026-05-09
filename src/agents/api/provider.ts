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
}

export interface AssistantStep {
  text: string;
  toolCalls: ApiToolCall[];
  /** True if the model decided to stop without further tool calls. */
  stop: boolean;
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
