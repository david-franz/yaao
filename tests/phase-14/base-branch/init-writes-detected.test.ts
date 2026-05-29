import { describe, it, expect } from 'vitest';
import { buildDefaultConfigJson } from '../../../src/init/scaffold.js';

describe('F14.9 — yaao init scaffolds defaults.base-branch from detection result', () => {
  it("buildDefaultConfigJson respects the detectedBaseBranch arg", () => {
    const body = buildDefaultConfigJson(undefined, 'master');
    const parsed = JSON.parse(body) as { defaults: { 'base-branch': string } };
    expect(parsed.defaults['base-branch']).toBe('master');
  });

  it("falls back to 'main' when no detection result is passed", () => {
    const body = buildDefaultConfigJson();
    const parsed = JSON.parse(body) as { defaults: { 'base-branch': string } };
    expect(parsed.defaults['base-branch']).toBe('main');
  });
});
