import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../helpers/cli.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

const PLAN = `plan: { name: viewme, version: 1 }
tasks:
  - id: a
    title: A
    agent: claude-code
    prompt: p
  - id: b
    title: B
    agent: claude-code
    prompt: p
    depends: [a]
`;

describe('yaao view', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('prints the layered DAG as text', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    project.write('plan.yaml', PLAN);
    const r = await runCli(['--cwd', project.path, 'view', 'plan.yaml', '--ascii']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('viewme');
    expect(r.stdout).toContain('layer 1');
    expect(r.stdout).toContain('layer 2');
  });

  it('--json emits the layers structure', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    project.write('plan.yaml', PLAN);
    const r = await runCli(['--cwd', project.path, '--json', 'view', 'plan.yaml']);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as { layers: string[][] };
    expect(parsed.layers).toEqual([['a'], ['b']]);
  });

  it('exits 2 when the plan is missing', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    const r = await runCli(['--cwd', project.path, 'view', 'missing.yaml']);
    expect(r.exitCode).toBe(2);
  });

  // appease unused-import lint if the join helper isn't referenced elsewhere here
  void writeFileSync;
  void join;
});
