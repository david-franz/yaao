import { describe, it, expect } from 'vitest';
import { runCli } from '../../helpers/cli.js';

const STUB_COMMANDS: { argv: string[]; phase: string }[] = [
  { argv: ['plan', 'a thing'], phase: 'F9' },
  { argv: ['convert', 'a-plan.md'], phase: 'F10' },
  { argv: ['validate', 'a-plan.yaml'], phase: 'F2' },
  { argv: ['view', 'a-plan.yaml'], phase: 'F11' },
  { argv: ['run', 'a-plan.yaml'], phase: 'F5' },
  { argv: ['status'], phase: 'F11' },
  { argv: ['merge'], phase: 'F6' },
  { argv: ['clean'], phase: 'F6' },
  { argv: ['agents'], phase: 'F4' },
  { argv: ['skills'], phase: 'F8' },
  { argv: ['doctor'], phase: 'F13' },
  { argv: ['serve'], phase: 'F12' },
  { argv: ['init'], phase: 'F1.4' },
];

describe('non-init stub commands', () => {
  for (const { argv, phase } of STUB_COMMANDS) {
    it(`yaao ${argv.join(' ')} exits 2 with phase=${phase}`, async () => {
      const r = await runCli(argv);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('not yet implemented');
      expect(r.stderr).toContain(phase);
    });
  }
});
