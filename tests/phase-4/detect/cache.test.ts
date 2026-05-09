import { describe, it, expect, beforeEach } from 'vitest';
import { detectAgents, clearAgentCache } from '../../../src/agents/detect.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import type { AgentBackend } from '../../../src/agents/backend.js';

describe('detectAgents cache', () => {
  beforeEach(() => clearAgentCache());

  it('caches the result for repeat calls within a process', async () => {
    let probeCalls = 0;
    const factory = (): AgentBackend[] => [
      {
        name: 'claude-code',
        isAvailable: async () => {
          probeCalls += 1;
          return { available: true, version: 'x' };
        },
        spawn: async () => {
          throw new Error('not used');
        },
      },
    ];
    await detectAgents(DEFAULT_CONFIG, { factory });
    await detectAgents(DEFAULT_CONFIG, { factory });
    expect(probeCalls).toBe(1);

    await detectAgents(DEFAULT_CONFIG, { factory, noCache: true });
    expect(probeCalls).toBe(2);
  });
});
