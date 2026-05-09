import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../helpers/cli.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';

describe('yaao run: --only and --skip together', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('rejects with a clear error', async () => {
    repo = createTestRepo();
    writeFileSync(
      join(repo.path, 'plan.yaml'),
      `plan: { name: x, version: 1 }
tasks:
  - id: a
    title: A
    agent: claude-code
    prompt: hi
`,
    );
    const r = await runCli([
      '--cwd',
      repo.path,
      'run',
      'plan.yaml',
      '--only',
      'a',
      '--skip',
      'a',
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/--only.*--skip/);
  });
});
