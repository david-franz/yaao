import { describe, it, expect } from 'vitest';
import { OpenAIProvider } from '../../../src/agents/api/backend.js';
import type { ApiRunRequest, AssistantStep } from '../../../src/agents/api/provider.js';

interface CapturedRequest {
  url: string;
  body: OpenAIRequestBody;
  headers: Record<string, string>;
}

interface OpenAIRequestBody {
  model: string;
  messages: { role: string; content?: string | null; tool_calls?: unknown[]; tool_call_id?: string }[];
  tools?: { type: string; function: { name: string; parameters: unknown } }[];
  max_tokens?: number;
}

function mockResponse(opts: {
  content?: string | null;
  toolCalls?: { id: string; name: string; arguments: string }[];
  finish?: string;
  usage?: Record<string, unknown>;
  status?: number;
  errorBody?: unknown;
}): Response {
  if (opts.status && opts.status !== 200) {
    return new Response(JSON.stringify(opts.errorBody ?? {}), {
      status: opts.status,
      headers: { 'content-type': 'application/json' },
    });
  }
  const message: { role: string; content: string | null; tool_calls?: unknown[] } = {
    role: 'assistant',
    content: opts.content ?? null,
  };
  if (opts.toolCalls && opts.toolCalls.length > 0) {
    message.tool_calls = opts.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }
  return new Response(
    JSON.stringify({
      choices: [{ message, finish_reason: opts.finish ?? (opts.toolCalls?.length ? 'tool_calls' : 'stop') }],
      ...(opts.usage ? { usage: opts.usage } : {}),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function fetchCapture(captured: CapturedRequest[], respond: () => Response): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    captured.push({
      url: url.toString(),
      body: JSON.parse(String(init?.body ?? '{}')) as OpenAIRequestBody,
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    return respond();
  }) as unknown as typeof fetch;
}

describe('F14.6 — OpenAIProvider', () => {
  it('POSTs to /v1/chat/completions with system + user messages and a Bearer token', async () => {
    const captured: CapturedRequest[] = [];
    const provider = new OpenAIProvider({
      fetchFn: fetchCapture(captured, () => mockResponse({ content: 'hello' })),
    });
    const req: ApiRunRequest = {
      systemPrompt: 'You are terse.',
      prompt: 'say hello',
      model: 'gpt-4o-mini',
      tools: [],
      apiKey: 'sk-test',
    };
    const step = await provider.step(req);
    expect(captured[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(captured[0]?.headers.authorization).toBe('Bearer sk-test');
    expect(captured[0]?.body.model).toBe('gpt-4o-mini');
    expect(captured[0]?.body.messages).toEqual([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'say hello' },
    ]);
    expect(step.text).toBe('hello');
    expect(step.stop).toBe(true);
  });

  it('translates tool definitions to OpenAI function shape', async () => {
    const captured: CapturedRequest[] = [];
    const provider = new OpenAIProvider({
      fetchFn: fetchCapture(captured, () => mockResponse({ content: 'ok' })),
    });
    const schema = { type: 'object', properties: { path: { type: 'string' } } };
    await provider.step({
      systemPrompt: 's',
      prompt: 'p',
      model: 'gpt-4o-mini',
      tools: [{ name: 'read_file', description: 'Read a file', inputSchema: schema }],
      apiKey: 'sk-test',
    });
    const tools = captured[0]?.body.tools ?? [];
    expect(tools[0]?.type).toBe('function');
    expect(tools[0]?.function.name).toBe('read_file');
    expect(tools[0]?.function.parameters).toEqual(schema);
  });

  it('parses a tool_call response and surfaces JSON-decoded input', async () => {
    const captured: CapturedRequest[] = [];
    const provider = new OpenAIProvider({
      fetchFn: fetchCapture(captured, () =>
        mockResponse({
          toolCalls: [
            {
              id: 'call_1',
              name: 'read_file',
              arguments: JSON.stringify({ path: 'README.md' }),
            },
          ],
        }),
      ),
    });
    const step = await provider.step({
      systemPrompt: 's',
      prompt: 'p',
      model: 'gpt-4o-mini',
      tools: [{ name: 'read_file', description: '', inputSchema: {} }],
      apiKey: 'sk-test',
    });
    expect(step.stop).toBe(false);
    expect(step.toolCalls).toEqual([
      { id: 'call_1', name: 'read_file', input: { path: 'README.md' } },
    ]);
  });

  it('replays prevAssistantMessages + tool_results as the OpenAI tool-message sequence', async () => {
    const captured: CapturedRequest[] = [];
    const provider = new OpenAIProvider({
      fetchFn: fetchCapture(captured, () => mockResponse({ content: 'done' })),
    });
    const prev: AssistantStep = {
      text: 'reading',
      toolCalls: [{ id: 'call_1', name: 'read_file', input: { path: 'README.md' } }],
      stop: false,
      toolResults: [{ id: 'call_1', content: '# yaao' }],
    };
    await provider.step({
      systemPrompt: 's',
      prompt: 'read README',
      model: 'gpt-4o-mini',
      tools: [{ name: 'read_file', description: '', inputSchema: {} }],
      prevAssistantMessages: [prev],
      apiKey: 'sk-test',
    });
    const msgs = captured[0]?.body.messages ?? [];
    // system → user → assistant(reading + tool_calls) → tool(call_1 result)
    expect(msgs[2]).toMatchObject({
      role: 'assistant',
      content: 'reading',
    });
    const asMsg = msgs[2] as { tool_calls?: unknown[] };
    expect(asMsg.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"README.md"}' },
      },
    ]);
    expect(msgs[3]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: '# yaao',
    });
  });

  it('surfaces cache_read tokens on AssistantStep.usage', async () => {
    const captured: CapturedRequest[] = [];
    const provider = new OpenAIProvider({
      fetchFn: fetchCapture(captured, () =>
        mockResponse({
          content: 'ok',
          usage: {
            prompt_tokens: 1200,
            completion_tokens: 50,
            prompt_tokens_details: { cached_tokens: 800 },
          },
        }),
      ),
    });
    const step = await provider.step({
      systemPrompt: 's',
      prompt: 'p',
      model: 'gpt-4o-mini',
      tools: [],
      apiKey: 'sk-test',
    });
    expect(step.usage?.inputTokens).toBe(1200);
    expect(step.usage?.outputTokens).toBe(50);
    expect(step.usage?.cacheRead).toBe(800);
  });

  it('throws with the response body on non-2xx', async () => {
    const provider = new OpenAIProvider({
      fetchFn: fetchCapture(
        [],
        () =>
          mockResponse({
            status: 401,
            errorBody: { error: { message: 'invalid api key' } },
          }),
      ),
    });
    await expect(
      provider.step({
        systemPrompt: 'secret-system',
        prompt: 'secret-user',
        model: 'gpt-4o-mini',
        tools: [],
        apiKey: 'sk-bad',
      }),
    ).rejects.toThrow(/openai 401/);
  });

  it('isAvailable reports missing key when none is configured', () => {
    const provider = new OpenAIProvider();
    expect(provider.isAvailable({}).available).toBe(false);
    expect(provider.isAvailable({ apiKey: 'x' }).available).toBe(true);
  });
});
