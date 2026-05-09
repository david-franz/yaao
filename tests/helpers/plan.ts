import { PlanSchema } from '../../src/plan/schema/plan.js';
import { resolvePlan, type ResolvedPlan } from '../../src/plan/schema/resolve.js';
import { DEFAULT_CONFIG } from '../../src/config/types.js';
import type { SourceMap } from '../../src/plan/yaml/loader.js';

export interface FakePlanInput {
  plan?: { name?: string; version?: 1; description?: string };
  config?: unknown;
  context?: unknown;
  includes?: string[];
  tasks?: unknown[];
}

/**
 * Build a `ResolvedPlan` from a loose Plan-shape input, suitable for unit-testing
 * validators without writing files. Accepts partial task records — Zod fills in
 * defaults (env/skills/files/retries/depends).
 */
export function fakeResolved(input: FakePlanInput): {
  plan: ResolvedPlan;
  source: SourceMap;
} {
  const merged = {
    plan: { name: 'test', version: 1, ...(input.plan ?? {}) },
    config: input.config,
    context: input.context,
    includes: input.includes ?? [],
    tasks: input.tasks ?? [],
  };
  const parsed = PlanSchema.parse(merged);
  const resolved = resolvePlan(parsed, { config: DEFAULT_CONFIG });
  const source: SourceMap = new Map(
    parsed.tasks.map((t, i) => [t.id, { file: 'inline', line: i + 1, col: 1 }]),
  );
  return { plan: resolved, source };
}
