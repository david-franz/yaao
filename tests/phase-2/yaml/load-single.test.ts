import { describe, it, expect, afterEach } from 'vitest';
import { loadPlan } from '../../../src/plan/yaml/loader.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('loadPlan: single file', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('loads a minimal plan and resolves defaults', async () => {
    project = createTmpProject();
    project.write(
      'plan.yaml',
      `plan:
  name: minimal
  version: 1
tasks:
  - id: hello
    title: Say hello
    agent: claude-code
    prompt: hi
`,
    );
    const r = await loadPlan('plan.yaml', { cwd: project.path, config: DEFAULT_CONFIG });
    expect(r.plan.plan.name).toBe('minimal');
    expect(r.plan.tasks).toHaveLength(1);
    expect(r.plan.tasks[0]?.branch).toBe('minimal/hello');
    expect(r.plan.config['max-parallel']).toBe(4);
    expect(r.files).toHaveLength(1);
  });
});
