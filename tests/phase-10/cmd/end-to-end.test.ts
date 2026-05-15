import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runCli } from '../../helpers/cli.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';
import { PlanSchema } from '../../../src/plan/schema/plan.js';

const SAMPLE = `# Add OAuth

> Add Google and GitHub providers.

## Metadata

- name: oauth
- scope: feature

## Tasks

| id        | title          | depends   | agent (suggested) | model (suggested) |
|-----------|----------------|-----------|-------------------|-------------------|
| scaffold  | Scaffold       |           |                   |                   |
| api       | REST API       | scaffold  |                   |                   |
| ui        | Login UI       | scaffold  |                   |                   |
| tests     | E2E tests      | api, ui   |                   |                   |

## scaffold — Scaffold

Set up the auth module.

## api — REST API

Implement callback endpoints.

## ui — Login UI

Build the login UI.

## tests — E2E tests

Cover the happy path.
`;

describe('yaao convert end-to-end', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('writes a schema-valid execution plan with built-in agent rules applied', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    project.write('.yaao/plans/oauth.md', SAMPLE);
    await runCli(['--cwd', project.path, 'init', '--minimal']);

    const r = await runCli([
      '--cwd',
      project.path,
      '--json',
      'convert',
      '.yaao/plans/oauth.md',
    ]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { outPath: string; tasks: number };
    expect(out.tasks).toBe(4);
    expect(existsSync(out.outPath)).toBe(true);
    const yaml = parseYaml(readFileSync(out.outPath, 'utf8'));
    const parsed = PlanSchema.parse(yaml);
    expect(parsed.tasks.map((t) => t.id).sort()).toEqual(['api', 'scaffold', 'tests', 'ui']);
    // built-in rules: tests → codex, ui → cursor
    expect(parsed.tasks.find((t) => t.id === 'tests')?.agent).toBe('codex');
    expect(parsed.tasks.find((t) => t.id === 'ui')?.agent).toBe('cursor');
    // 'api' → no rule matches → default agent
    expect(parsed.tasks.find((t) => t.id === 'api')?.agent).toBe(
      'claude-code',
    );

    // outPath defaults to .yaao/exec/<slug>.yaml
    expect(out.outPath).toContain(join('.yaao', 'exec'));
  });
});
