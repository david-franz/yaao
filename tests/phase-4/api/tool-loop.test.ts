import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiBackend } from '../../../src/agents/api/backend.js';
import { FakeApiProvider } from '../../../src/agents/api/fake-provider.js';
import { ApiKeyMissingError, ApiToolLoopBudgetError } from '../../../src/log/errors.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('ApiBackend tool-use loop', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('runs tool calls in the sandbox and resolves on stop', async () => {
    project = createTmpProject();
    const provider = new FakeApiProvider({
      steps: [
        {
          text: 'I will write a file.\n',
          toolCalls: [
            { id: 'c1', name: 'write_file', input: { path: 'hello.txt', contents: 'hi\n' } },
          ],
          stop: false,
        },
        { text: 'Done.\n', toolCalls: [], stop: true },
      ],
    });
    const backend = new ApiBackend({ provider, apiKey: 'sk-test' });
    const proc = await backend.spawn({ cwd: project.path, prompt: 'please' });
    const events: string[] = [];
    for await (const ev of proc.events) events.push(`${ev.type}:${ev.data.length}`);
    const result = await proc.completed;
    expect(result.exitCode).toBe(0);
    expect(result.toolUseCount).toBe(1);
    expect(existsSync(join(project.path, 'hello.txt'))).toBe(true);
    expect(readFileSync(join(project.path, 'hello.txt'), 'utf8')).toBe('hi\n');
    expect(result.stdout).toContain('I will write a file');
  });

  it('throws ApiKeyMissingError when no key is configured', async () => {
    project = createTmpProject();
    const provider = new FakeApiProvider({ steps: [] });
    const backend = new ApiBackend({ provider });
    await expect(backend.spawn({ cwd: project.path, prompt: 'p' })).rejects.toBeInstanceOf(
      ApiKeyMissingError,
    );
  });

  it('enforces tool-loop budget', async () => {
    project = createTmpProject();
    // A provider that keeps requesting tool calls forever.
    const provider = new FakeApiProvider({
      steps: Array.from({ length: 100 }, (_, i) => ({
        text: `step ${i}\n`,
        toolCalls: [{ id: `c${i}`, name: 'list_files', input: {} }],
        stop: false,
      })),
    });
    const backend = new ApiBackend({ provider, apiKey: 'sk', toolBudget: 3 });
    const proc = await backend.spawn({ cwd: project.path, prompt: 'p' });
    // Drain events to keep the loop unblocked.
    void (async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of proc.events) { /* drain */ }
    })();
    await expect(proc.completed).rejects.toBeInstanceOf(ApiToolLoopBudgetError);
  });
});
