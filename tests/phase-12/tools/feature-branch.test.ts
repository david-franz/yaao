import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { yaaoConvertTool, yaaoInspectTool, type ToolContext } from '../../../src/mcp/tools.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import { PlanSchema } from '../../../src/plan/schema/plan.js';
import { resolvePlan, resolveBranchPolicy } from '../../../src/plan/schema/resolve.js';
import { planBranches } from '../../../src/git/branch-graph.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

const MD = `# Hello

## Tasks

| id | title | depends |
|----|-------|---------|
| a  | A     |         |
| b  | B     | a       |

## a — A
prose

## b — B
prose
`;

describe('plan.featureBranch', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('PlanSchema accepts featureBranch under the plan header', () => {
    const parsed = PlanSchema.parse({
      plan: { name: 'p', version: 1, featureBranch: 'feature/x' },
      tasks: [
        { id: 't', title: 'T', prompt: 'do', agent: 'claude-code' },
      ],
    });
    expect(parsed.plan.featureBranch).toBe('feature/x');
  });

  it('resolveBranchPolicy makes featureBranch the merge target when set', () => {
    const parsed = PlanSchema.parse({
      plan: { name: 'p', version: 1, featureBranch: 'feature/x' },
      tasks: [{ id: 't', title: 'T', prompt: 'do', agent: 'claude-code' }],
    });
    const resolved = resolvePlan(parsed, { config: DEFAULT_CONFIG });
    const policy = resolveBranchPolicy(resolved);
    expect(policy.baseBranch).toBe('main');
    expect(policy.featureBranch).toBe('feature/x');
    expect(policy.mergeTarget).toBe('feature/x');
  });

  it('resolveBranchPolicy falls back to baseBranch when featureBranch is absent', () => {
    const parsed = PlanSchema.parse({
      plan: { name: 'p', version: 1 },
      tasks: [{ id: 't', title: 'T', prompt: 'do', agent: 'claude-code' }],
    });
    const resolved = resolvePlan(parsed, { config: DEFAULT_CONFIG });
    const policy = resolveBranchPolicy(resolved);
    expect(policy.featureBranch).toBeUndefined();
    expect(policy.mergeTarget).toBe('main');
  });

  it('planBranches sources layer-0 tasks off the featureBranch when set', () => {
    const parsed = PlanSchema.parse({
      plan: { name: 'p', version: 1, featureBranch: 'feature/serial' },
      tasks: [
        { id: 'a', title: 'A', prompt: 'do', agent: 'claude-code' },
        { id: 'b', title: 'B', prompt: 'do', agent: 'claude-code', depends: ['a'] },
      ],
    });
    const resolved = resolvePlan(parsed, { config: DEFAULT_CONFIG });
    const bp = planBranches(resolved);
    // Layer-0 tasks branch off featureBranch (preserving any pre-existing
    // commits on it); dependent tasks still branch off their parent.
    expect(bp.byTask.get('a')?.baseBranch).toBe('feature/serial');
    expect(bp.byTask.get('b')?.baseBranch).toBe('p/a');
  });

  it('yaao_convert writes featureBranch into plan.featureBranch and echoes it back', async () => {
    project = createTmpProject();
    project.write('plan.md', MD);
    const ctx: ToolContext = { cwd: project.path, config: DEFAULT_CONFIG };
    const r = await yaaoConvertTool({ input: 'plan.md', featureBranch: 'feature/abc' }, ctx);
    expect(r.structuredContent['featureBranch']).toBe('feature/abc');
    const outPath = r.structuredContent['outPath'] as string;
    expect(existsSync(outPath)).toBe(true);
    const written = parseYaml(readFileSync(outPath, 'utf8')) as { plan: { featureBranch?: string } };
    expect(written.plan.featureBranch).toBe('feature/abc');
  });

  it('yaao_convert omits featureBranch when not passed', async () => {
    project = createTmpProject();
    project.write('plan.md', MD);
    const ctx: ToolContext = { cwd: project.path, config: DEFAULT_CONFIG };
    const r = await yaaoConvertTool({ input: 'plan.md' }, ctx);
    expect(r.structuredContent['featureBranch']).toBeNull();
    const outPath = r.structuredContent['outPath'] as string;
    const written = parseYaml(readFileSync(outPath, 'utf8')) as { plan: { featureBranch?: string } };
    expect(written.plan.featureBranch).toBeUndefined();
  });

  it('yaao_inspect surfaces plan.featureBranch from the exec YAML', async () => {
    project = createTmpProject();
    const execYaml = `plan:
  name: serial-driver
  version: 1
  featureBranch: feature/serial
tasks:
  - id: a
    title: A
    prompt: do
    agent: claude-code
`;
    project.write(join('.yaao', 'exec', 'serial-driver.yaml'), execYaml);
    const ctx: ToolContext = { cwd: project.path, config: DEFAULT_CONFIG };
    const r = await yaaoInspectTool({}, ctx);
    const plans = r.structuredContent['plans'] as { slug: string; featureBranch?: string | null }[];
    const row = plans.find((p) => p.slug === 'serial-driver');
    expect(row?.featureBranch).toBe('feature/serial');
  });
});
