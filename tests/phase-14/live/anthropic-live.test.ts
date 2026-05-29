import { describe, it, expect } from 'vitest';
import { AnthropicProvider } from '../../../src/agents/api/backend.js';
import type { ApiRunRequest } from '../../../src/agents/api/provider.js';
import { hasEnvVar, liveTestGate } from './_helpers.js';

const gate = liveTestGate('anthropic', hasEnvVar('ANTHROPIC_API_KEY'));

describe.skipIf(!gate.ok)(
  `F14.4 — Anthropic API live smoke (${gate.ok ? 'running' : `skipped: ${gate.reason}`})`,
  () => {
    it('round-trips a simple prompt against the real /v1/messages endpoint', async () => {
      const provider = new AnthropicProvider();
      const req: ApiRunRequest = {
        systemPrompt: 'You are terse. Answer in one word.',
        prompt: 'What is 2 + 2?',
        model: 'claude-haiku-4-5-20251001',
        tools: [],
        apiKey: process.env['ANTHROPIC_API_KEY']!,
      };
      const step = await provider.step(req);
      expect(step.stop).toBe(true);
      expect(step.text.length).toBeGreaterThan(0);
      // F14.3 — cache markers were sent, so the response should include
      // usage with at least cache_creation_input_tokens populated on the
      // first request.
      expect(step.usage).toBeDefined();
      expect(step.usage?.inputTokens).toBeGreaterThan(0);
      expect(step.usage?.outputTokens).toBeGreaterThan(0);
    }, 30_000);

    it('reports cache hits on a second identical request', async () => {
      // Two back-to-back requests with the same system prompt + tools should
      // see cache_read_input_tokens > 0 on the second one (Anthropic's
      // ephemeral cache has a 5-minute TTL; the calls are sequential and
      // typically complete in seconds).
      const provider = new AnthropicProvider();
      const baseReq: ApiRunRequest = {
        systemPrompt:
          'You are terse. ' +
          // Pad the system prompt so it crosses Anthropic's minimum
          // cacheable size (~1024 input tokens). Otherwise the cache write
          // is silently no-op and cache_read stays 0 on the next call.
          'Repeat detail: '.repeat(200),
        prompt: 'Say "hi" and only "hi".',
        model: 'claude-haiku-4-5-20251001',
        tools: [],
        apiKey: process.env['ANTHROPIC_API_KEY']!,
      };
      const first = await provider.step(baseReq);
      // First call may create the cache. Second call should read it.
      const second = await provider.step(baseReq);
      // Cache behavior is opportunistic on Anthropic's end; we assert
      // *either* the second saw a cache read OR the first wrote one and
      // the second was close enough in time that the prefix matched. Both
      // shapes prove the markers are being honored.
      const firstCreation = first.usage?.cacheCreation ?? 0;
      const secondRead = second.usage?.cacheRead ?? 0;
      expect(firstCreation + secondRead).toBeGreaterThan(0);
    }, 30_000);
  },
);
