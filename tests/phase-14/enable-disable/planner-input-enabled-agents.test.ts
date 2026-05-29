import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlanner } from '../../../src/planner/run.js';
import { ConfigSchema } from '../../../src/config/schema.js';
import type {
  AgentBackend,
  AgentProcess,
  AvailabilityReport,
  SpawnOptions,
} from '../../../src/agents/backend.js';

function fakeBackend(): AgentBackend {
  return {
    name: 'claude-code',
    isAvailable: async (): Promise<AvailabilityReport> => ({ available: true }),
    spawn: async (_opts: SpawnOptions): Promise<AgentProcess> => {
      throw new Error('fake backend should not be spawned in dry-run');
    },
  };
}

describe('F14.1 — planner threads enabled-agents into the prompt', () => {
  it('renders enabled-agents placeholder when only copilot is enabled', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'yaao-planner-'));
    const config = ConfigSchema.parse({
      version: 1,
      agents: {
        'claude-code': { enabled: false },
        cursor: { enabled: false },
        copilot: { enabled: true },
        codex: { enabled: false },
      },
    });
    const r = await runPlanner({
      cwd,
      config,
      description: 'add a healthz endpoint',
      dryRun: true,
      backend: fakeBackend(),
    });
    expect(r.prompt).toContain('copilot');
    // No literal {{enabled-agents}} placeholder should remain unsubstituted
    expect(r.prompt).not.toContain('{{enabled-agents}}');
  });

  it('refuses to run when no agent is enabled', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'yaao-planner-'));
    const config = ConfigSchema.parse({
      version: 1,
      agents: {
        'claude-code': { enabled: false },
        cursor: { enabled: false },
        copilot: { enabled: false },
        codex: { enabled: false },
      },
    });
    await expect(
      runPlanner({
        cwd,
        config,
        description: 'x',
        dryRun: true,
        backend: fakeBackend(),
      }),
    ).rejects.toThrow(/YAAO_NO_ENABLED_AGENTS|no enabled agent/);
  });
});
