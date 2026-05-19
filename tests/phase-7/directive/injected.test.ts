import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';
import type { AgentBackend, SpawnOptions } from '../../../src/agents/backend.js';
import { CTX_SYS_DIRECTIVE } from '../../../src/ctx-sys/directive.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';

function makeRecorder(captured: SpawnOptions[]): AgentBackend {
  const inner = new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] });
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'spawn') {
        return async (opts: SpawnOptions) => {
          captured.push(opts);
          const { writeFileSync: w } = await import('node:fs');
          w(join(opts.cwd, 'marker.txt'), 'x');
          return target.spawn(opts);
        };
      }
      return Reflect.get(target, prop) as unknown;
    },
  });
}

describe('ctx-sys directive injection', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('injects the directive into the system prompt when ctxSysDirective is provided', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, 'plan: { name: d, version: 1 }\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'd' },
      tasks: [{ id: 'a', title: 'A', agent: 'claude-code', prompt: 'hi' }],
    });
    const captured: SpawnOptions[] = [];
    await runPlan({
      requireTrackedPlan: 'off',
      runId: 'r',
      plan,
      planFile,
      rootDir: repo.path,
      config: DEFAULT_CONFIG,
      backendFor: () => makeRecorder(captured),
      ctxSysDirective: CTX_SYS_DIRECTIVE,
    });
    expect(captured[0]?.systemPrompt).toContain('context_query');
  });

  it('omits the ctx-sys directive when ctxSysDirective is not provided', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, 'plan: { name: d, version: 1 }\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'd' },
      tasks: [{ id: 'a', title: 'A', agent: 'claude-code', prompt: 'hi' }],
    });
    const captured: SpawnOptions[] = [];
    await runPlan({
      requireTrackedPlan: 'off',
      runId: 'r',
      plan,
      planFile,
      rootDir: repo.path,
      config: DEFAULT_CONFIG,
      backendFor: () => makeRecorder(captured),
    });
    // The yaao authorization preamble is always present, but the ctx-sys
    // directive is not added when ctxSysDirective is unset.
    expect(captured[0]?.systemPrompt).not.toContain('context_query');
  });

  it('honors directive: false at the task level (still keeps the yaao authorization)', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, 'plan: { name: d, version: 1 }\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'd' },
      tasks: [
        {
          id: 'trivial',
          title: 'Trivial',
          agent: 'claude-code',
          prompt: 'fix typo',
          context: { 'ctx-sys': { directive: false } },
        },
      ],
    });
    const captured: SpawnOptions[] = [];
    await runPlan({
      requireTrackedPlan: 'off',
      runId: 'r',
      plan,
      planFile,
      rootDir: repo.path,
      config: DEFAULT_CONFIG,
      backendFor: () => makeRecorder(captured),
      ctxSysDirective: CTX_SYS_DIRECTIVE,
    });
    expect(captured[0]?.systemPrompt).not.toContain('context_query');
    expect(captured[0]?.systemPrompt).toMatch(/yaao/);
  });
});
