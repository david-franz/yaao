import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..', '..');
const cliPath = join(projectRoot, 'dist', 'bin', 'yaao.js');

const require = createRequire(import.meta.url);
const pkg = require(join(projectRoot, 'package.json')) as { version: string };

describe('CLI --version', () => {
  it('matches package.json version', () => {
    if (!existsSync(cliPath)) {
      // build is required for this test; skip cleanly when running test:watch on a fresh clone.
      return;
    }
    const out = execFileSync(process.execPath, [cliPath, '--version'], {
      encoding: 'utf8',
    }).trim();
    expect(out).toBe(pkg.version);
  });
});
