import { describe, it, expect, afterEach } from 'vitest';
import { loadPlan } from '../../../src/plan/yaml/loader.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import { PlanParseError, PlanNotFoundError } from '../../../src/log/errors.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('loadPlan: parse errors', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('reports YAML syntax errors with file/line', async () => {
    project = createTmpProject();
    project.write(
      'plan.yaml',
      // unmatched bracket triggers a real parser error
      `plan:
  name: bad
  version: 1
tasks: [
  - id: a
    title: A
    agent: claude-code
    prompt: hi
`,
    );
    try {
      await loadPlan('plan.yaml', { cwd: project.path, config: DEFAULT_CONFIG });
    } catch (e) {
      expect(e).toBeInstanceOf(PlanParseError);
      expect((e as PlanParseError).file).toContain('plan.yaml');
      return;
    }
    throw new Error('expected PlanParseError');
  });

  it('throws PlanNotFoundError for missing files', async () => {
    project = createTmpProject();
    await expect(
      loadPlan('nope.yaml', { cwd: project.path, config: DEFAULT_CONFIG }),
    ).rejects.toBeInstanceOf(PlanNotFoundError);
  });
});
