import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';

describe('runner forwards task:agent-event to the journal (so the web SSE stream can render live agent activity)', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('emits a task:agent-event journal entry for every bus agent-event', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: vis\n  version: 1\ntasks: []\n');

    const backend = new FakeBackend({
      events: [
        { type: 'thinking', data: 'considering the API surface' },
        { type: 'tool-use', data: '{"name":"Read","input":{"path":"src/index.ts"}}' },
        { type: 'stdout', data: 'wrote 1 file\n' },
      ],
    });

    const { plan } = fakeResolved({
      plan: { name: 'vis' },
      tasks: [{ id: 't', title: 'T', agent: 'claude-code', prompt: 'p' }],
    });

    await runPlan({
      requireTrackedPlan: 'off',
      runId: 'vis1',
      plan,
      planFile,
      rootDir: repo.path,
      config: DEFAULT_CONFIG,
      backendFor: () => backend,
    });

    const journalPath = join(repo.path, '.yaao', 'runs', 'vis1', 'journal.jsonl');
    const lines = readFileSync(journalPath, 'utf8').split('\n').filter(Boolean);
    const agentEvents = lines
      .map((l) => JSON.parse(l) as { t: string; ev?: { type: string; data: string } })
      .filter((e) => e.t === 'task:agent-event');

    const kinds = agentEvents.map((e) => e.ev?.type);
    expect(kinds).toContain('thinking');
    expect(kinds).toContain('tool-use');
    expect(kinds).toContain('stdout');
    // The data payload is preserved verbatim — the web reducer extracts the
    // tool name from this blob.
    const tool = agentEvents.find((e) => e.ev?.type === 'tool-use');
    expect(tool?.ev?.data).toContain('"name":"Read"');
  });
});
