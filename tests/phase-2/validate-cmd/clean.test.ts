import { describe, it, expect, afterEach } from 'vitest';
import { runCli } from '../../helpers/cli.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('yaao validate: clean plan', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('exits 0 and prints ✔ ok', async () => {
    project = createTmpProject();
    project.write(
      'plan.yaml',
      `plan:
  name: clean
  version: 1
tasks:
  - id: a
    title: A
    agent: claude-code
    prompt: hi
`,
    );
    const r = await runCli(['--cwd', project.path, 'validate', 'plan.yaml']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/ok/);
  });
});
