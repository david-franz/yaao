import { describe, it, expect, afterEach } from 'vitest';
import { loadPlan } from '../../../src/plan/yaml/loader.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('loadPlan: includes', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('loads tasks from included sub-plans, in include order', async () => {
    project = createTmpProject();
    project.write(
      'plan.yaml',
      `plan:
  name: root
  version: 1
includes:
  - ./api.yaml
  - ./ui.yaml
tasks:
  - id: scaffold
    title: Scaffold
    agent: claude-code
    prompt: scaffold
`,
    );
    project.write(
      'api.yaml',
      `plan:
  name: api
  version: 1
tasks:
  - id: api-1
    title: API task 1
    agent: claude-code
    prompt: api1
`,
    );
    project.write(
      'ui.yaml',
      `plan:
  name: ui
  version: 1
tasks:
  - id: ui-1
    title: UI task 1
    agent: claude-code
    prompt: ui1
`,
    );

    const r = await loadPlan('plan.yaml', { cwd: project.path, config: DEFAULT_CONFIG });
    const ids = r.plan.tasks.map((t) => t.id);
    expect(ids).toEqual(['scaffold', 'api-1', 'ui-1']);
    expect(r.files.length).toBe(3);
  });
});
