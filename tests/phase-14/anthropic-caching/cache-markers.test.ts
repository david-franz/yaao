import { describe, it, expect } from 'vitest';
import { AnthropicProvider } from '../../../src/agents/api/backend.js';
import type { ApiRunRequest, AssistantStep } from '../../../src/agents/api/provider.js';

interface CapturedRequest {
  url: string;
  body: AnthropicRequestBody;
  headers: Record<string, string>;
}

interface AnthropicRequestBody {
  model: string;
  system?: { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[] | string;
  messages: { role: string; content: unknown }[];
  tools?: { name: string; description: string; input_schema: unknown; cache_control?: { type: 'ephemeral' } }[];
  max_tokens?: number;
}

function mockResponse(opts: {
  text?: string;
  toolCalls?: { id: string; name: string; input: unknown }[];
  usage?: Record<string, number>;
}): Response {
  const content: unknown[] = [];
  if (opts.text) content.push({ type: 'text', text: opts.text });
  for (const tc of opts.toolCalls ?? []) {
    content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
  }
  return new Response(
    JSON.stringify({
      content,
      stop_reason: opts.toolCalls?.length ? 'tool_use' : 'end_turn',
      ...(opts.usage ? { usage: opts.usage } : {}),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function fetchCapture(captured: CapturedRequest[], respond: () => Response): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    captured.push({
      url: url.toString(),
      body: JSON.parse(String(init?.body ?? '{}')) as AnthropicRequestBody,
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    return respond();
  }) as unknown as typeof fetch;
}

describe('F14.3 — Anthropic prompt caching markers', () => {
  it('marks the system prompt with cache_control: ephemeral', async () => {
    const captured: CapturedRequest[] = [];
    const provider = new AnthropicProvider({
      fetchFn: fetchCapture(captured, () => mockResponse({ text: 'ok' })),
    });
    const req: ApiRunRequest = {
      systemPrompt: 'You are a helpful agent.',
      prompt: 'do thing',
      model: 'claude-opus-4-7',
      tools: [],
      apiKey: 'sk-test',
    };
    await provider.step(req);
    const body = captured[0]?.body;
    expect(Array.isArray(body?.system)).toBe(true);
    const sys = body?.system as { text: string; cache_control?: { type: 'ephemeral' } }[];
    expect(sys[0]?.text).toBe('You are a helpful agent.');
    expect(sys[sys.length - 1]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('marks the last tool in the tools array with cache_control: ephemeral', async () => {
    const captured: CapturedRequest[] = [];
    const provider = new AnthropicProvider({
      fetchFn: fetchCapture(captured, () => mockResponse({ text: 'ok' })),
    });
    const req: ApiRunRequest = {
      systemPrompt: 's',
      prompt: 'p',
      model: 'claude-opus-4-7',
      tools: [
        { name: 'a', description: 'A', inputSchema: { type: 'object' } },
        { name: 'b', description: 'B', inputSchema: { type: 'object' } },
        { name: 'c', description: 'C', inputSchema: { type: 'object' } },
      ],
      apiKey: 'sk-test',
    };
    await provider.step(req);
    const tools = captured[0]?.body.tools ?? [];
    expect(tools.length).toBe(3);
    expect(tools[0]?.cache_control).toBeUndefined();
    expect(tools[1]?.cache_control).toBeUndefined();
    expect(tools[tools.length - 1]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('marks the most recent tool_result block in messages', async () => {
    const captured: CapturedRequest[] = [];
    const provider = new AnthropicProvider({
      fetchFn: fetchCapture(captured, () => mockResponse({ text: 'ok' })),
    });
    const prevStep: AssistantStep = {
      text: '',
      toolCalls: [{ id: 'tc-1', name: 'read_file', input: { path: 'x' } }],
      stop: false,
      toolResults: [{ id: 'tc-1', content: 'file contents' }],
    };
    const req: ApiRunRequest = {
      systemPrompt: 's',
      prompt: 'p',
      model: 'claude-opus-4-7',
      tools: [],
      prevAssistantMessages: [prevStep],
      apiKey: 'sk-test',
    };
    await provider.step(req);
    const messages = captured[0]?.body.messages ?? [];
    // Find the message with the tool_result and assert cache_control is set.
    let foundMarked = false;
    for (const m of messages) {
      if (typeof m.content === 'string') continue;
      for (const b of m.content as { type: string; cache_control?: { type: 'ephemeral' } }[]) {
        if (b.type === 'tool_result' && b.cache_control?.type === 'ephemeral') {
          foundMarked = true;
        }
      }
    }
    expect(foundMarked).toBe(true);
  });

  it('returns usage stats including cache_read and cache_creation tokens', async () => {
    const captured: CapturedRequest[] = [];
    const provider = new AnthropicProvider({
      fetchFn: fetchCapture(captured, () =>
        mockResponse({
          text: 'ok',
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 80,
          },
        }),
      ),
    });
    const step = await provider.step({
      systemPrompt: 's',
      prompt: 'p',
      model: 'claude-opus-4-7',
      tools: [],
      apiKey: 'sk-test',
    });
    expect(step.usage).toBeDefined();
    expect(step.usage?.inputTokens).toBe(100);
    expect(step.usage?.outputTokens).toBe(50);
    expect(step.usage?.cacheRead).toBe(80);
    expect(step.usage?.cacheCreation).toBe(0);
  });

  it('still authenticates and uses the configured baseUrl', async () => {
    const captured: CapturedRequest[] = [];
    const provider = new AnthropicProvider({
      fetchFn: fetchCapture(captured, () => mockResponse({ text: 'ok' })),
    });
    await provider.step({
      systemPrompt: 's',
      prompt: 'p',
      model: 'claude-opus-4-7',
      tools: [],
      apiKey: 'sk-test-xyz',
      baseUrl: 'https://example.anthropic.test',
    });
    expect(captured[0]?.url).toBe('https://example.anthropic.test/v1/messages');
    expect(captured[0]?.headers['x-api-key']).toBe('sk-test-xyz');
    expect(captured[0]?.headers['anthropic-version']).toBe('2023-06-01');
  });
});
