import { describe, it, expect, afterEach } from 'vitest';
import { loadInputPlan } from '../../../src/converter/load-plan.js';
import { YaaoError } from '../../../src/log/errors.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

const MD = `# Add OAuth

> short description

## Tasks

| id | title | depends |
|----|-------|---------|
| a  | A     |         |

## a — A

prose
`;

const SPECKIT_TASKS = `# Plan — Tasks

- [ ] **a** — A
  - depends:

  prose
`;

describe('loadInputPlan auto-detect', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('reads a single markdown file as markdown', () => {
    project = createTmpProject();
    project.write('plan.md', MD);
    const r = loadInputPlan({ cwd: project.path, input: 'plan.md' });
    expect(r.format).toBe('markdown');
    expect(r.plan.tasks[0]?.id).toBe('a');
  });

  it('reads a directory with tasks.md as speckit', () => {
    project = createTmpProject();
    project.write('triplet/tasks.md', SPECKIT_TASKS);
    project.write('triplet/spec.md', '# Plan — Spec\n\nDescription');
    const r = loadInputPlan({ cwd: project.path, input: 'triplet' });
    expect(r.format).toBe('speckit');
    expect(r.plan.tasks[0]?.id).toBe('a');
  });

  it('reports missing inputs', () => {
    const p = createTmpProject();
    project = p;
    expect(() => loadInputPlan({ cwd: p.path, input: 'nope.md' })).toThrow(YaaoError);
  });

  it('refuses a Spec Kit directory without tasks.md', () => {
    const p = createTmpProject();
    project = p;
    p.write('triplet/spec.md', '# Plan');
    expect(() => loadInputPlan({ cwd: p.path, input: 'triplet' })).toThrow(YaaoError);
  });
});
