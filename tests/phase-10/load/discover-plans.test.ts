import { describe, it, expect, afterEach } from 'vitest';
import { discoverPlans } from '../../../src/converter/load-plan.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

const MD = `# Plan

> body

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

describe('discoverPlans (recursive)', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('returns a single markdown entry for a .md file', () => {
    project = createTmpProject();
    project.write('plan.md', MD);
    const r = discoverPlans({ cwd: project.path, input: 'plan.md' });
    expect(r).toHaveLength(1);
    expect(r[0]?.format).toBe('markdown');
    expect(r[0]?.slug).toBe('plan');
  });

  it('returns a single speckit entry when a top-level directory has tasks.md', () => {
    project = createTmpProject();
    project.write('triplet/tasks.md', SPECKIT_TASKS);
    project.write('triplet/spec.md', '# Plan — Spec');
    const r = discoverPlans({ cwd: project.path, input: 'triplet' });
    expect(r).toHaveLength(1);
    expect(r[0]?.format).toBe('speckit');
  });

  it('walks a directory recursively and finds nested markdown + speckit plans', () => {
    project = createTmpProject();
    project.write('plans/oauth.md', MD);
    project.write('plans/phases/phase-1.md', MD);
    project.write('plans/phases/phase-2.md', MD);
    project.write('plans/spec/tasks.md', SPECKIT_TASKS);
    project.write('plans/spec/spec.md', '# Spec');
    const r = discoverPlans({ cwd: project.path, input: 'plans' });
    const byFormat = { markdown: 0, speckit: 0 };
    for (const p of r) byFormat[p.format] += 1;
    expect(byFormat.markdown).toBe(3); // oauth.md + phase-1.md + phase-2.md
    expect(byFormat.speckit).toBe(1); // plans/spec/
    // Speckit walker stops at the triplet directory — must not also re-emit tasks.md.
    expect(r.find((p) => p.slug === 'tasks')).toBeUndefined();
  });

  it('skips .git, node_modules, .yaao/exec, .yaao/runs, .yaao/worktrees', () => {
    project = createTmpProject();
    project.write('plans/keep.md', MD);
    project.write('.git/should-skip.md', MD);
    project.write('node_modules/pkg/skip.md', MD);
    project.write('plans/exec/should-skip.md', MD);
    project.write('plans/runs/should-skip.md', MD);
    project.write('plans/worktrees/should-skip.md', MD);
    const r = discoverPlans({ cwd: project.path, input: '.' });
    const slugs = r.map((p) => p.slug);
    expect(slugs).toEqual(['keep']);
  });
});
