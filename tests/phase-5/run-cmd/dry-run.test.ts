import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../helpers/cli.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';

describe('yaao run --dry-run', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('prints the layered execution order without spawning agents', async () => {
    repo = createTestRepo();
    writeFileSync(
      join(repo.path, 'plan.yaml'),
      `plan: { name: dry, version: 1 }
tasks:
  - id: a
    title: A
    agent: claude-code
    prompt: hi
  - id: b
    title: B
    agent: claude-code
    prompt: hi
    depends: [a]
`,
    );
    const r = await runCli(['--cwd', repo.path, '--json', 'run', 'plan.yaml', '--dry-run']);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as { plan: string; layers: string[][] };
    expect(parsed.plan).toBe('dry');
    expect(parsed.layers[0]).toEqual(['a']);
    expect(parsed.layers[1]).toEqual(['b']);
    // No worktrees were created.
    expect(existsSync(join(repo.path, '.yaao', 'worktrees'))).toBe(false);
  });
});
