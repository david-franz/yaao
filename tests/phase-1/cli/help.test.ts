import { describe, it, expect } from 'vitest';
import { runCli } from '../../helpers/cli.js';

const EXPECTED_COMMANDS = [
  'init',
  'plan',
  'convert',
  'validate',
  'view',
  'run',
  'status',
  'merge',
  'clean',
  'agents',
  'skills',
  'doctor',
  'serve',
];

describe('yaao --help', () => {
  it('lists every command', async () => {
    const r = await runCli(['--help']);
    const text = r.stdout + r.stderr;
    for (const cmd of EXPECTED_COMMANDS) {
      expect(text).toContain(cmd);
    }
  });
});
