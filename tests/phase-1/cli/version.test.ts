import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runCli } from '../../helpers/cli.js';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = require(join(here, '..', '..', '..', 'package.json')) as { version: string };

describe('yaao --version (in-process)', () => {
  it('prints the package version', async () => {
    const r = await runCli(['--version']);
    expect(r.stdout.trim()).toBe(pkg.version);
  });
});
