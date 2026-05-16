import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { convertPlan } from '../../../src/converter/convert.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

interface ExecPlan {
  tasks: { id: string; validation?: { command: string; cwd?: string } }[];
}

function readExecPlan(path: string): ExecPlan {
  return parseYaml(readFileSync(path, 'utf8')) as ExecPlan;
}

describe('convertPlan: validation.cwd inference from task files', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('sets validation.cwd to the deepest common dir of task.files', async () => {
    project = createTmpProject();
    project.write(
      '.yaao/plans/sample.md',
      `# Sample

## Tasks

| id      | title       | depends |
|---------|-------------|---------|
| api    | API tests | |
| web    | Web build | |

## api — API tests

Implement the API.

### Files
- apps/api/src/routes/auth.ts
- apps/api/src/middleware/jwt.ts
- apps/api/prisma/schema.prisma

### Validation
- \`pnpm test\`

## web — Web build

Implement the web app.

### Files
- apps/web/src/app/page.tsx
- apps/web/src/components/Hero.tsx

### Validation
- \`pnpm build\`
`,
    );

    const result = await convertPlan({
      cwd: project.path,
      config: DEFAULT_CONFIG,
      input: '.yaao/plans/sample.md',
      out: join(project.path, '.yaao/exec/sample.yaml'),
    });

    const plan = readExecPlan(result.outPath);
    const api = plan.tasks.find((t) => t.id === 'api');
    const web = plan.tasks.find((t) => t.id === 'web');
    expect(api?.validation?.cwd).toBe('apps/api');
    expect(api?.validation?.command).toBe('pnpm test');
    expect(web?.validation?.cwd).toBe('apps/web');
    expect(web?.validation?.command).toBe('pnpm build');
  });

  it('explicit `cd <dir> &&` prefix still wins over the inferred prefix', async () => {
    project = createTmpProject();
    project.write(
      '.yaao/plans/sample.md',
      `# Sample

## Tasks

| id | title | depends |
|----|-------|---------|
| t | T | |

## t — T

### Files
- apps/api/src/x.ts
- apps/api/src/y.ts

### Validation
- \`cd apps/api/migrations && prisma migrate dev\`
`,
    );

    const result = await convertPlan({
      cwd: project.path,
      config: DEFAULT_CONFIG,
      input: '.yaao/plans/sample.md',
      out: join(project.path, '.yaao/exec/sample.yaml'),
    });

    const plan = readExecPlan(result.outPath);
    const t = plan.tasks[0];
    // The explicit cd target wins, not the inferred apps/api prefix.
    expect(t?.validation?.cwd).toBe('apps/api/migrations');
    expect(t?.validation?.command).toBe('prisma migrate dev');
  });
});
