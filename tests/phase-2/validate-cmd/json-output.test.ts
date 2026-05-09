import { describe, it, expect, afterEach } from 'vitest';
import { runCli } from '../../helpers/cli.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('yaao validate --json', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('emits a parseable result on stdout', async () => {
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
    const r = await runCli(['--cwd', project.path, 'validate', 'plan.yaml', '--json']);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as { ok: boolean; issues: unknown[] };
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.issues)).toBe(true);
  });
});
