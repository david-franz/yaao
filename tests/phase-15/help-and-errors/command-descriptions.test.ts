import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const COMMANDS_DIR = resolve(__dirname, '../../../src/cli/commands');

/**
 * F15.4 — every command's .description(...) should be richer than the
 * bare verb (the pre-v1 audit's specific gap). We grep each command's
 * source for `.description(` and assert the argument is at least one
 * sentence plus a clarifying clause.
 *
 * This is a coarse heuristic — the real review is in the docs/phase-14
 * audit and the human eye. The test exists so a regression to a bare
 * verb-only description is caught at CI time, not by a user reading
 * `--help`.
 */
const COMMANDS = [
  'init',
  'plan',
  'convert',
  'validate',
  'view',
  'run',
  'stop',
  'status',
  'merge',
  'clean',
  'agents',
  'skills',
  'doctor',
  'serve',
  'web',
];

const MIN_DESCRIPTION_CHARS = 60;

describe('F15.4 — every command has a meaningful --help description', () => {
  for (const cmd of COMMANDS) {
    it(`${cmd} description is at least one sentence beyond the verb`, () => {
      const src = readFileSync(join(COMMANDS_DIR, `${cmd}.ts`), 'utf8');
      const match = src.match(/\.description\(\s*(?:'([^']+)'|"([^"]+)"|`([^`]+)`)/s);
      const literal = match?.[1] ?? match?.[2] ?? match?.[3];
      // Some commands use multi-line descriptions wrapped across lines —
      // the regex above catches single-line forms; long-form descriptions
      // are matched by a fallback below.
      const multilineMatch = src.match(/\.description\(\s*([\s\S]+?)\)/);
      const text = literal ?? multilineMatch?.[1] ?? '';
      // Strip quotes/whitespace and assert minimum length.
      const stripped = text.replace(/['"`]/g, '').trim();
      expect(stripped.length).toBeGreaterThanOrEqual(MIN_DESCRIPTION_CHARS);
    });
  }
});
