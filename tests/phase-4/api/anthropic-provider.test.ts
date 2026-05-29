import { describe, it, expect } from 'vitest';
import { AnthropicProvider } from '../../../src/agents/api/backend.js';
import type { ApiRunRequest, ApiToolDefinition } from '../../../src/agents/api/provider.js';

const TOOLS: ApiToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read a file in the worktree.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];

interface RecordedFetch {
  url: string;
  init: RequestInit;
  body: unknown;
}

function makeFetch(
  responses: { status?: number; body: unknown }[],
): { fn: typeof fetch; calls: RecordedFetch[] } {
  const calls: RecordedFetch[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const i = calls.length;
    const r = responses[i];
    calls.push({
      url: String(url),
      init: init ?? {},
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (!r) throw new Error(`unexpected extra fetch #${i + 1}`);
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('AnthropicProvider', () => {
  it('isAvailable() requires an apiKey', () => {
    const p = new AnthropicProvider();
    expect(p.isAvailable({})).toEqual({
      available: false,
      reason: 'no ANTHROPIC_API_KEY configured',
    });
    expect(p.isAvailable({ apiKey: 'sk-test' })).toEqual({ available: true });
  });

  it('single-turn: assistant returns text, no tool calls → stop=true', async () => {
    const { fn, calls } = makeFetch([
      {
        body: {
          content: [{ type: 'text', text: 'Hello there.' }],
          stop_reason: 'end_turn',
        },
      },
    ]);
    const p = new AnthropicProvider({ fetchFn: fn });
    const req: ApiRunRequest = {
      systemPrompt: 'be terse',
      prompt: 'hi',
      model: 'claude-opus-4-7',
      tools: TOOLS,
      apiKey: 'sk-test',
    };
    const step = await p.step(req);
    expect(step.text).toBe('Hello there.');
    expect(step.toolCalls).toEqual([]);
    expect(step.stop).toBe(true);

    // Request shape: model + system + messages + tools, plus the correct
    // auth/version headers.
    const c = calls[0]!;
    expect(c.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = c.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['content-type']).toBe('application/json');
    const body = c.body as Record<string, unknown>;
    expect(body['model']).toBe('claude-opus-4-7');
    // F14.3 — system is now an array of content blocks with a
    // cache_control marker on the last (only) block to enable prompt
    // caching across steps in a spawn.
    expect(body['system']).toEqual([
      { type: 'text', text: 'be terse', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body['messages']).toEqual([{ role: 'user', content: 'hi' }]);
    // F14.3 — the last tool in the tools array carries cache_control so
    // the tools list is cached across requests within a spawn.
    expect(body['tools']).toEqual([
      {
        name: 'read_file',
        description: 'Read a file in the worktree.',
        input_schema: TOOLS[0]!.inputSchema,
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });

  it('multi-turn: tool_use → tool_result is replayed correctly on the next step', async () => {
    const { fn, calls } = makeFetch([
      {
        body: {
          content: [
            { type: 'text', text: 'reading the file' },
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'read_file',
              input: { path: 'README.md' },
            },
          ],
          stop_reason: 'tool_use',
        },
      },
      {
        body: {
          content: [{ type: 'text', text: 'done' }],
          stop_reason: 'end_turn',
        },
      },
    ]);
    const p = new AnthropicProvider({ fetchFn: fn });

    // First step: produces a tool_use; stop=false because stop_reason='tool_use'.
    const first = await p.step({
      systemPrompt: '',
      prompt: 'read README',
      model: 'claude-opus-4-7',
      tools: TOOLS,
      apiKey: 'sk',
    });
    expect(first.stop).toBe(false);
    expect(first.toolCalls).toEqual([
      { id: 'tu_1', name: 'read_file', input: { path: 'README.md' } },
    ]);

    // Caller fed tool result back. Anthropic requires tool_result blocks to
    // immediately follow the assistant turn that emitted tool_use — the
    // provider reconstructs this from prevAssistantMessages[i].toolResults.
    first.toolResults = [{ id: 'tu_1', content: '# yaao\n' }];

    const second = await p.step({
      systemPrompt: '',
      prompt: 'read README',
      model: 'claude-opus-4-7',
      tools: TOOLS,
      prevAssistantMessages: [first],
      apiKey: 'sk',
    });
    expect(second.stop).toBe(true);

    // Second request's messages array carries the full multi-turn conversation:
    //   user prompt → assistant (text + tool_use) → user (tool_result) → ?
    const second_body = calls[1]!.body as { messages: unknown[] };
    // F14.3 — the most recent tool_result block carries cache_control:
    // ephemeral so step N+1 sees step N's conversation in cache.
    expect(second_body.messages).toEqual([
      { role: 'user', content: 'read README' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reading the file' },
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'read_file',
            input: { path: 'README.md' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: '# yaao\n',
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ]);
  });

  it('surfaces error response bodies in the thrown message but does not leak the request payload', async () => {
    const { fn } = makeFetch([
      {
        status: 401,
        body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
      },
    ]);
    const p = new AnthropicProvider({ fetchFn: fn });
    await expect(
      p.step({
        systemPrompt: 'secret system prompt',
        prompt: 'secret user prompt',
        model: 'claude-opus-4-7',
        tools: TOOLS,
        apiKey: 'sk-bad',
      }),
    ).rejects.toThrow(/anthropic 401/);
    // Make sure the request body isn't echoed back in the error message.
    await expect(
      p.step({
        systemPrompt: 'secret system prompt',
        prompt: 'secret user prompt',
        model: 'claude-opus-4-7',
        tools: TOOLS,
        apiKey: 'sk-bad',
      }),
    ).rejects.not.toThrow(/secret system prompt|secret user prompt/);
  });

  it('throws when the request has no apiKey', async () => {
    const p = new AnthropicProvider({ fetchFn: makeFetch([]).fn });
    await expect(
      p.step({
        systemPrompt: '',
        prompt: 'hi',
        model: 'claude-opus-4-7',
        tools: TOOLS,
      }),
    ).rejects.toThrow(/without apiKey/);
  });

  it('threads AbortSignal through to fetch', async () => {
    const { fn, calls } = makeFetch([
      { body: { content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' } },
    ]);
    const ac = new AbortController();
    const p = new AnthropicProvider({ fetchFn: fn });
    await p.step({
      systemPrompt: '',
      prompt: 'hi',
      model: 'claude-opus-4-7',
      tools: TOOLS,
      apiKey: 'sk',
      signal: ac.signal,
    });
    expect(calls[0]!.init.signal).toBe(ac.signal);
  });
});
