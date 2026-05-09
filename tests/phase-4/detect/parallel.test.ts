import { describe, it, expect, beforeEach } from 'vitest';
import { detectAgents, clearAgentCache } from '../../../src/agents/detect.js';
import { FakeBackend } from '../../../src/agents/fake.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';

describe('detectAgents', () => {
  beforeEach(() => clearAgentCache());

  it('probes every backend in parallel', async () => {
    const start = Date.now();
    const claude = new FakeBackend({ events: [], availability: { available: true, version: '1' } }, 'claude-code');
    const cursor = new FakeBackend({ events: [], availability: { available: true, version: '2' } }, 'cursor');
    const codex = new FakeBackend({ events: [], availability: { available: false, reason: 'no bin' } }, 'codex');
    const r = await detectAgents(DEFAULT_CONFIG, {
      noCache: true,
      factory: () => [claude, cursor, codex],
    });
    expect(r.byName.get('claude-code')?.available).toBe(true);
    expect(r.byName.get('cursor')?.available).toBe(true);
    expect(r.byName.get('codex')?.available).toBe(false);
    expect(r.byName.get('codex')?.reason).toBe('no bin');
    expect(Date.now() - start).toBeLessThan(5000);
  });
});
