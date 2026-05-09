import { describe, it, expect, afterEach } from 'vitest';
import { runCli } from '../../helpers/cli.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('yaao agents --json', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('emits a parseable agents array', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    const r = await runCli(['--cwd', project.path, '--json', 'agents']);
    // exit may be 0 or 1 depending on local env (some agents will be unavailable)
    expect([0, 1]).toContain(r.exitCode);
    const parsed = JSON.parse(r.stdout) as { agents: { agent: string; available: boolean }[] };
    expect(Array.isArray(parsed.agents)).toBe(true);
    expect(parsed.agents.length).toBeGreaterThan(0);
    // claude-code should always be present in the report
    expect(parsed.agents.find((a) => a.agent === 'claude-code')).toBeDefined();
  });
});
