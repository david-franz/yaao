import { describe, it, expect, afterEach } from 'vitest';
import { runCli } from '../../helpers/cli.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('exit codes', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('a YaaoError (literal-secret) exits 1', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    project.write(
      '.yaao/yaao.config.json',
      JSON.stringify({
        version: 1,
        agents: { api: { providers: { x: { 'api-key': 'literal-key' } } } },
      }),
    );
    // a non-bootstrap command triggers the loader and surfaces the error
    const r = await runCli(['--cwd', project.path, 'plan', 'x']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('YAAO_LITERAL_SECRET');
  });

  it('a YaaoError prints the default hint', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    project.write(
      '.yaao/yaao.config.json',
      JSON.stringify({
        version: 1,
        agents: { api: { providers: { x: { 'api-key': '${MISSING_VAR_FOR_TEST}' } } } },
      }),
    );
    const r = await runCli(['--cwd', project.path, 'plan', 'x']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('MISSING_VAR_FOR_TEST');
    expect(r.stderr).toContain('hint:');
  });
});
