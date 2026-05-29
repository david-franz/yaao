import { describe, it, expect } from 'vitest';
import { OpenRouterProvider } from '../../../src/agents/api/backend.js';
import type { ApiRunRequest } from '../../../src/agents/api/provider.js';

interface CapturedRequest {
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

function fetchCapture(captured: CapturedRequest[]): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    captured.push({
      url: url.toString(),
      body: JSON.parse(String(init?.body ?? '{}')),
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
}

describe('F14.6 — OpenRouterProvider', () => {
  it('defaults baseUrl to openrouter.ai and uses Bearer auth', async () => {
    const captured: CapturedRequest[] = [];
    const provider = new OpenRouterProvider({ fetchFn: fetchCapture(captured) });
    const req: ApiRunRequest = {
      systemPrompt: 's',
      prompt: 'p',
      model: 'anthropic/claude-3.5-sonnet',
      tools: [],
      apiKey: 'sk-or-test',
    };
    await provider.step(req);
    expect(captured[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(captured[0]?.headers.authorization).toBe('Bearer sk-or-test');
  });

  it('sets the attribution headers OpenRouter recommends', async () => {
    const captured: CapturedRequest[] = [];
    const provider = new OpenRouterProvider({ fetchFn: fetchCapture(captured) });
    await provider.step({
      systemPrompt: 's',
      prompt: 'p',
      model: 'openai/gpt-4o',
      tools: [],
      apiKey: 'sk-or-test',
    });
    expect(captured[0]?.headers['HTTP-Referer']).toBeDefined();
    expect(captured[0]?.headers['X-Title']).toBe('yaao');
  });

  it('honors a per-request baseUrl override', async () => {
    const captured: CapturedRequest[] = [];
    const provider = new OpenRouterProvider({ fetchFn: fetchCapture(captured) });
    await provider.step({
      systemPrompt: 's',
      prompt: 'p',
      model: 'openai/gpt-4o',
      tools: [],
      apiKey: 'sk-or-test',
      baseUrl: 'https://example.openrouter.test',
    });
    expect(captured[0]?.url).toBe('https://example.openrouter.test/v1/chat/completions');
  });

  it('isAvailable reports missing key when none is configured', () => {
    const provider = new OpenRouterProvider();
    expect(provider.isAvailable({}).available).toBe(false);
    expect(provider.isAvailable({ apiKey: 'x' }).available).toBe(true);
  });
});
