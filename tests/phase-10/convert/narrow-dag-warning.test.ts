import { describe, it, expect, afterEach } from 'vitest';
import { convertPlan } from '../../../src/converter/convert.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

const LINEAR_MD = `# Linear

## Tasks

| id | title | depends |
|----|-------|---------|
| a  | Core  |         |
| b  | Wire  | a       |
| c  | Shell | b       |
| d  | Docs  | c       |

## a — Core
prose

## b — Wire
prose

## c — Shell
prose

## d — Docs
prose
`;

const FAN_OUT_MD = `# Fanout

## Tasks

| id | title  | depends |
|----|--------|---------|
| a  | Core   |         |
| b  | Wire   | a       |
| c  | Shell  | a       |
| d  | Docs   | a       |

## a — Core
prose

## b — Wire
prose

## c — Shell
prose

## d — Docs
prose
`;

describe('convert narrow-DAG warning', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('warns when the plan is a strict chain wider than two tasks', async () => {
    project = createTmpProject();
    project.write('plan.md', LINEAR_MD);
    const r = await convertPlan({ cwd: project.path, config: DEFAULT_CONFIG, input: 'plan.md' });
    expect(r.warnings.some((w) => w.includes('YAAO_PLAN_NARROW_DAG'))).toBe(true);
  });

  it('does not warn when there is at least one parallel sibling layer', async () => {
    project = createTmpProject();
    project.write('plan.md', FAN_OUT_MD);
    const r = await convertPlan({ cwd: project.path, config: DEFAULT_CONFIG, input: 'plan.md' });
    expect(r.warnings.some((w) => w.includes('YAAO_PLAN_NARROW_DAG'))).toBe(false);
  });
});
