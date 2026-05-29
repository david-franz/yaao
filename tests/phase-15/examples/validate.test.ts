import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadPlan } from '../../../src/plan/yaml/loader.js';
import { validatePlan } from '../../../src/plan/validate/index.js';
import { ConfigSchema } from '../../../src/config/schema.js';
import type { AgentAvailability } from '../../../src/plan/validate/types.js';

// A maximally-permissive config: every CLI agent enabled, every API
// provider configured with a dummy key. This is the canonical "what a
// fully-set-up workspace looks like" against which the examples must
// pass validation.
const PERMISSIVE_CONFIG = ConfigSchema.parse({
  version: 1,
  agents: {
    api: {
      providers: {
        anthropic: { 'api-key': 'sk-test' },
        openai: { 'api-key': 'sk-test' },
        openrouter: { 'api-key': 'sk-test' },
      },
    },
  },
});

const EXAMPLES_ROOT = resolve(__dirname, '../../../examples');

/**
 * F15.3 — every plan under examples/ must pass `yaao validate` with no
 * schema or DAG errors. We pretend every agent is available and every
 * provider has a key so the examples don't bind users to specific
 * vendor logins. The agent-disable / api-no-key checks fire on the
 * user's real config at run time; examples ship as the canonical "what
 * a clean plan looks like."
 */
const ALL_AGENTS_AVAILABLE: AgentAvailability = {
  available: { 'claude-code': true, cursor: true, copilot: true, codex: true, api: true },
  apiKeys: { anthropic: true, openai: true, openrouter: true },
};

function collectYamlFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const abs = join(root, entry);
    const s = statSync(abs);
    if (s.isDirectory()) {
      out.push(...collectYamlFiles(abs));
    } else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
      out.push(abs);
    }
  }
  return out;
}

describe('F15.3 — examples/*.yaml all pass yaao validate', () => {
  const files = collectYamlFiles(EXAMPLES_ROOT);

  it('finds at least three example plans (one per subdirectory)', () => {
    const subdirs = new Set(
      files.map((f) => f.slice(EXAMPLES_ROOT.length).split('/').filter(Boolean)[0]),
    );
    expect(subdirs.size).toBeGreaterThanOrEqual(3);
    expect(subdirs.has('typescript-monorepo')).toBe(true);
    expect(subdirs.has('python-flask')).toBe(true);
    expect(subdirs.has('c-kernel')).toBe(true);
  });

  for (const file of files) {
    const rel = file.slice(EXAMPLES_ROOT.length + 1);
    it(`${rel} validates with no errors`, async () => {
      const loaded = await loadPlan(file, { cwd: EXAMPLES_ROOT, config: PERMISSIVE_CONFIG });
      const issues = validatePlan(loaded.plan, loaded.source, {
        config: PERMISSIVE_CONFIG,
        agents: ALL_AGENTS_AVAILABLE,
      });
      const errors = issues.filter((i) => i.severity === 'error');
      if (errors.length > 0) {
        // Surface the actual errors so a regression is debuggable.
        // eslint-disable-next-line no-console
        console.error(`Validation errors in ${rel}:`, errors);
      }
      expect(errors).toEqual([]);
    });
  }
});
