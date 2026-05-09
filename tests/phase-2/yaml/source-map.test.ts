import { describe, it, expect, afterEach } from 'vitest';
import { loadPlan } from '../../../src/plan/yaml/loader.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('loadPlan: source map', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('records file/line/col for each task by id', async () => {
    project = createTmpProject();
    project.write(
      'plan.yaml',
      `plan:
  name: src
  version: 1
tasks:
  - id: alpha
    title: Alpha
    agent: claude-code
    prompt: a
  - id: beta
    title: Beta
    agent: claude-code
    prompt: b
`,
    );

    const r = await loadPlan('plan.yaml', { cwd: project.path, config: DEFAULT_CONFIG });
    const alpha = r.source.get('alpha');
    const beta = r.source.get('beta');
    expect(alpha?.file).toContain('plan.yaml');
    expect(alpha?.line).toBeGreaterThan(0);
    expect(beta?.line).toBeGreaterThan(alpha?.line ?? 0);
  });
});
