import { describe, it, expect, beforeEach } from 'vitest';
import { detectAgents, clearAgentCache } from '../../../src/agents/detect.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import type { AgentBackend, AvailabilityReport } from '../../../src/agents/backend.js';

describe('detectAgents: a throwing probe is isolated', () => {
  beforeEach(() => clearAgentCache());

  it("doesn't break sibling probes", async () => {
    const throwing: AgentBackend = {
      name: 'cursor',
      isAvailable: async () => {
        throw new Error('boom');
      },
      spawn: async () => {
        throw new Error('not used');
      },
    };
    const ok: AgentBackend = {
      name: 'claude-code',
      isAvailable: async (): Promise<AvailabilityReport> => ({ available: true, version: 'x' }),
      spawn: async () => {
        throw new Error('not used');
      },
    };
    const r = await detectAgents(DEFAULT_CONFIG, {
      noCache: true,
      factory: () => [throwing, ok],
    });
    expect(r.byName.get('claude-code')?.available).toBe(true);
    expect(r.byName.get('cursor')?.available).toBe(false);
    expect(r.byName.get('cursor')?.reason).toBe('boom');
  });
});
