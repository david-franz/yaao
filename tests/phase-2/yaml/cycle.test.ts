import { describe, it, expect, afterEach } from 'vitest';
import { loadPlan } from '../../../src/plan/yaml/loader.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import { IncludeCycleError, IncludeDepthError } from '../../../src/log/errors.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('loadPlan: cycle and depth detection', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('rejects an include cycle', async () => {
    project = createTmpProject();
    project.write(
      'a.yaml',
      `plan:
  name: a
  version: 1
includes: [./b.yaml]
`,
    );
    project.write(
      'b.yaml',
      `plan:
  name: b
  version: 1
includes: [./a.yaml]
`,
    );
    await expect(
      loadPlan('a.yaml', { cwd: project.path, config: DEFAULT_CONFIG }),
    ).rejects.toBeInstanceOf(IncludeCycleError);
  });

  it('respects maxIncludeDepth', async () => {
    project = createTmpProject();
    // Build a chain a -> b -> c -> d -> e
    project.write('a.yaml', `plan: { name: a, version: 1 }\nincludes: [./b.yaml]\n`);
    project.write('b.yaml', `plan: { name: b, version: 1 }\nincludes: [./c.yaml]\n`);
    project.write('c.yaml', `plan: { name: c, version: 1 }\nincludes: [./d.yaml]\n`);
    project.write('d.yaml', `plan: { name: d, version: 1 }\nincludes: [./e.yaml]\n`);
    project.write('e.yaml', `plan: { name: e, version: 1 }\n`);
    await expect(
      loadPlan('a.yaml', { cwd: project.path, config: DEFAULT_CONFIG, maxIncludeDepth: 2 }),
    ).rejects.toBeInstanceOf(IncludeDepthError);
  });
});
