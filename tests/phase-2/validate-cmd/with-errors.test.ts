import { describe, it, expect, afterEach } from 'vitest';
import { runCli } from '../../helpers/cli.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('yaao validate: errors', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('reports a cycle and exits 1', async () => {
    project = createTmpProject();
    project.write(
      'plan.yaml',
      `plan:
  name: bad
  version: 1
tasks:
  - id: a
    title: A
    agent: claude-code
    prompt: hi
    depends: [b]
  - id: b
    title: B
    agent: claude-code
    prompt: hi
    depends: [a]
`,
    );
    const r = await runCli(['--cwd', project.path, 'validate', 'plan.yaml']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('YAAO_PLAN_CYCLE');
  });

  it('exits 2 when the plan file is missing', async () => {
    project = createTmpProject();
    const r = await runCli(['--cwd', project.path, 'validate', 'nope.yaml']);
    expect(r.exitCode).toBe(2);
  });

  it('exits 2 on a YAML syntax error', async () => {
    project = createTmpProject();
    project.write(
      'plan.yaml',
      `plan:
  name: bad
  version: 1
tasks: [
  - id: a
`,
    );
    const r = await runCli(['--cwd', project.path, 'validate', 'plan.yaml']);
    expect(r.exitCode).toBe(2);
  });
});
