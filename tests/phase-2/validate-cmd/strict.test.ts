import { describe, it, expect, afterEach } from 'vitest';
import { runCli } from '../../helpers/cli.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('yaao validate --strict', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('promotes a skill warning to an error', async () => {
    project = createTmpProject();
    project.write(
      'plan.yaml',
      `plan:
  name: warn
  version: 1
tasks:
  - id: a
    title: A
    agent: claude-code
    prompt: hi
    skills: [unknown-skill]
`,
    );
    const lenient = await runCli(['--cwd', project.path, 'validate', 'plan.yaml']);
    expect(lenient.exitCode).toBe(0);

    const strict = await runCli(['--cwd', project.path, 'validate', 'plan.yaml', '--strict']);
    expect(strict.exitCode).toBe(1);
  });
});
