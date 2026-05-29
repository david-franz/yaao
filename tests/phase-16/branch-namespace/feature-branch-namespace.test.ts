import { describe, it, expect } from 'vitest';
import { PlanSchema } from '../../../src/plan/schema/plan.js';
import { resolvePlan } from '../../../src/plan/schema/resolve.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';

describe('F16.1 — default task-branch namespacing under plan.featureBranch', () => {
  it("puts task branches under a featureBranch-derived namespace (slash-sanitized) when featureBranch is set", () => {
    const raw = PlanSchema.parse({
      plan: { name: 'oauth', version: 1, featureBranch: 'feature/foo' },
      tasks: [
        { id: 'api', title: 'API', agent: 'claude-code', prompt: 'p' },
        { id: 'ui', title: 'UI', agent: 'claude-code', prompt: 'p' },
      ],
    });
    const resolved = resolvePlan(raw, { config: DEFAULT_CONFIG });
    // The slashes in 'feature/foo' get replaced with '-' so the
    // task-branch namespace doesn't collide with git's ref store
    // (which forbids `feature/foo` the branch AND `feature/foo/api`
    // the would-be sibling from coexisting). Sanitized namespace:
    // `feature-foo`.
    expect(resolved.tasks.map((t) => t.branch)).toEqual(['feature-foo/api', 'feature-foo/ui']);
  });

  it("falls back to <plan-name>/<task-id> when featureBranch is absent (legacy shape preserved)", () => {
    const raw = PlanSchema.parse({
      plan: { name: 'oauth', version: 1 },
      tasks: [{ id: 'api', title: 'API', agent: 'claude-code', prompt: 'p' }],
    });
    const resolved = resolvePlan(raw, { config: DEFAULT_CONFIG });
    expect(resolved.tasks[0]?.branch).toBe('oauth/api');
  });

  it("respects an explicit per-task `branch:` field (no namespacing applied)", () => {
    const raw = PlanSchema.parse({
      plan: { name: 'oauth', version: 1, featureBranch: 'feature/foo' },
      tasks: [
        {
          id: 'api',
          title: 'API',
          agent: 'claude-code',
          prompt: 'p',
          branch: 'custom/branch-name',
        },
      ],
    });
    const resolved = resolvePlan(raw, { config: DEFAULT_CONFIG });
    expect(resolved.tasks[0]?.branch).toBe('custom/branch-name');
  });

  it("two plans against distinct feature branches produce disjoint task-branch namespaces", () => {
    const a = resolvePlan(
      PlanSchema.parse({
        plan: { name: 'shared', version: 1, featureBranch: 'feature/a' },
        tasks: [{ id: 'api', title: 'A', agent: 'claude-code', prompt: 'p' }],
      }),
      { config: DEFAULT_CONFIG },
    );
    const b = resolvePlan(
      PlanSchema.parse({
        plan: { name: 'shared', version: 1, featureBranch: 'feature/b' },
        tasks: [{ id: 'api', title: 'B', agent: 'claude-code', prompt: 'p' }],
      }),
      { config: DEFAULT_CONFIG },
    );
    expect(a.tasks[0]?.branch).toBe('feature-a/api');
    expect(b.tasks[0]?.branch).toBe('feature-b/api');
    expect(a.tasks[0]?.branch).not.toBe(b.tasks[0]?.branch);
  });

  it("worktree path remains keyed by plan.name + task.id (NOT renamed by F16.1)", () => {
    const raw = PlanSchema.parse({
      plan: { name: 'oauth', version: 1, featureBranch: 'feature/foo' },
      tasks: [{ id: 'api', title: 'A', agent: 'claude-code', prompt: 'p' }],
    });
    const resolved = resolvePlan(raw, { config: DEFAULT_CONFIG });
    expect(resolved.tasks[0]?.worktree).toMatch(/oauth\/api$/);
  });

  it("featureBranch with no slashes is also sanitized (identity transform)", () => {
    const raw = PlanSchema.parse({
      plan: { name: 'oauth', version: 1, featureBranch: 'feat-x' },
      tasks: [{ id: 'api', title: 'A', agent: 'claude-code', prompt: 'p' }],
    });
    const resolved = resolvePlan(raw, { config: DEFAULT_CONFIG });
    // No slashes to replace → namespace is the featureBranch verbatim.
    expect(resolved.tasks[0]?.branch).toBe('feat-x/api');
  });
});
