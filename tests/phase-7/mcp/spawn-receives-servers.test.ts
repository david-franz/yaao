import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';
import type { AgentBackend, McpServerConfig, SpawnOptions } from '../../../src/agents/backend.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';

describe('lifecycle threads MCP servers into every spawn', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('every backend.spawn call sees the configured mcpServers list', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(
      planFile,
      `plan: { name: mcp, version: 1 }
tasks:
  - id: a
    title: A
    agent: claude-code
    prompt: hi
`,
    );
    const { plan } = fakeResolved({
      plan: { name: 'mcp' },
      tasks: [{ id: 'a', title: 'A', agent: 'claude-code', prompt: 'hi' }],
    });

    const captured: SpawnOptions[] = [];
    const inner = new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] });
    const proxied: AgentBackend = new Proxy(inner, {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: SpawnOptions) => {
            captured.push(opts);
            // Touch the worktree so something is committable.
            const { writeFileSync: w } = await import('node:fs');
            w(join(opts.cwd, 'a.txt'), 'a\n');
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });

    const mcpServers: McpServerConfig[] = [
      { name: 'yaao', command: 'yaao', args: ['serve'], env: {} },
      { name: 'ctx-sys', command: 'ctx-sys', args: ['serve', '--socket', '/tmp/x'], env: {} },
    ];
    const result = await runPlan({
      requireTrackedPlan: 'off',
      runId: 'r1',
      plan,
      planFile,
      rootDir: repo.path,
      config: DEFAULT_CONFIG,
      backendFor: () => proxied,
      mcpServers,
    });
    expect(result.status).toBe('success');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.mcpServers).toEqual(mcpServers);
  });
});
