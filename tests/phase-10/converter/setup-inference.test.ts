import { describe, it, expect } from 'vitest';
import { extractValidationCwd, inferSetupFromValidation } from '../../../src/converter/convert.js';

describe('inferSetupFromValidation', () => {
  it('prepends a conditional install when validation uses a package manager', () => {
    expect(inferSetupFromValidation('pnpm build')).toEqual([
      'if [ -f package.json ]; then pnpm install; fi',
    ]);
    expect(inferSetupFromValidation('pnpm typecheck')).toEqual([
      'if [ -f package.json ]; then pnpm install; fi',
    ]);
  });

  it('uses npm or yarn when those are the validation manager', () => {
    expect(inferSetupFromValidation('npm test')).toEqual([
      'if [ -f package.json ]; then npm install; fi',
    ]);
    expect(inferSetupFromValidation('yarn lint')).toEqual([
      'if [ -f package.json ]; then yarn install; fi',
    ]);
  });

  it('adds compose + env setup when validation runs a prisma migration', () => {
    const setup = inferSetupFromValidation('pnpm prisma migrate dev');
    expect(setup).toContain('if [ -f package.json ]; then pnpm install; fi');
    expect(setup).toContain('docker compose up -d postgres 2>/dev/null || true');
    expect(setup).toContain('cp -n .env.example .env 2>/dev/null || true');
  });

  it('skips install when there is no package.json yet (bootstrap-friendly)', async () => {
    // Run the inferred command in a temp dir with no package.json — it should
    // exit 0 because the `if` guard short-circuits.
    const { execa } = await import('execa');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const cwd = mkdtempSync(join(tmpdir(), 'yaao-setup-'));
    try {
      const cmd = inferSetupFromValidation('pnpm build')[0]!;
      const r = await execa('sh', ['-c', cmd], { cwd, reject: false });
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('returns nothing for shell validations that do not match a known pattern', () => {
    expect(inferSetupFromValidation('./scripts/check.sh')).toEqual([]);
    expect(inferSetupFromValidation('grep -q OK out.txt')).toEqual([]);
  });
});

describe('extractValidationCwd', () => {
  it('strips leading `cd <dir> &&` into a structured cwd', () => {
    expect(extractValidationCwd('cd apps/api && pnpm prisma migrate dev')).toEqual({
      command: 'pnpm prisma migrate dev',
      cwd: 'apps/api',
    });
    expect(extractValidationCwd('cd packages/db && yarn migrate')).toEqual({
      command: 'yarn migrate',
      cwd: 'packages/db',
    });
  });

  it('leaves plain commands alone', () => {
    expect(extractValidationCwd('pnpm build')).toEqual({ command: 'pnpm build' });
  });
});
