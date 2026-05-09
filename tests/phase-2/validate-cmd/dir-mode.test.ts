import { describe, it, expect, afterEach } from 'vitest';
import { runCli } from '../../helpers/cli.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('yaao validate: directory mode', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('validates every *.yaml in a directory; aggregates exit code', async () => {
    project = createTmpProject();
    project.write(
      'plans/clean.yaml',
      `plan: { name: clean, version: 1 }
tasks:
  - id: a
    title: A
    agent: claude-code
    prompt: hi
`,
    );
    project.write(
      'plans/broken.yaml',
      `plan: { name: broken, version: 1 }
tasks:
  - id: a
    title: A
    agent: claude-code
    prompt: hi
    depends: [a]
`,
    );
    const r = await runCli(['--cwd', project.path, 'validate', 'plans']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('clean.yaml');
    expect(r.stderr).toContain('broken.yaml');
  });
});
