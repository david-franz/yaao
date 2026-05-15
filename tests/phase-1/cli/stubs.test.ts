import { describe, it, expect } from 'vitest';
import { runCli } from '../../helpers/cli.js';

const STUB_COMMANDS: { argv: string[]; phase: string }[] = [
  { argv: ['doctor'], phase: 'F13' },
  { argv: ['serve'], phase: 'F12' },
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
