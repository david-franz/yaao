import { describe, it, expect } from 'vitest';
import { inferSetupFromValidation } from '../../../src/converter/convert.js';

describe('inferSetupFromValidation', () => {
  it('prepends pnpm install when validation starts with pnpm', () => {
    expect(inferSetupFromValidation('pnpm build')).toEqual(['pnpm install']);
    expect(inferSetupFromValidation('pnpm typecheck')).toEqual(['pnpm install']);
  });

  it('uses npm or yarn when those are the validation manager', () => {
    expect(inferSetupFromValidation('npm test')).toEqual(['npm install']);
    expect(inferSetupFromValidation('yarn lint')).toEqual(['yarn install']);
  });

  it('adds compose + env setup when validation runs a prisma migration', () => {
    const setup = inferSetupFromValidation('pnpm prisma migrate dev');
    expect(setup).toContain('pnpm install');
    expect(setup).toContain('docker compose up -d postgres 2>/dev/null || true');
    expect(setup).toContain('cp -n .env.example .env 2>/dev/null || true');
  });

  it('returns nothing for shell validations that do not match a known pattern', () => {
    expect(inferSetupFromValidation('./scripts/check.sh')).toEqual([]);
    expect(inferSetupFromValidation('grep -q OK out.txt')).toEqual([]);
  });
});
