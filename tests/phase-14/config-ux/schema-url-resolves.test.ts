import { describe, it, expect } from 'vitest';
import { buildDefaultConfigJson } from '../../../src/init/scaffold.js';

describe('F14.8 — scaffold $schema URL', () => {
  it('no longer points at yaao.dev', () => {
    const body = buildDefaultConfigJson();
    expect(body).not.toMatch(/yaao\.dev/);
  });

  it('points at the GitHub raw URL for the in-repo schema artifact', () => {
    const body = buildDefaultConfigJson();
    const parsed = JSON.parse(body) as { $schema?: string };
    expect(parsed.$schema).toMatch(/raw\.githubusercontent\.com.*schema\/config\.schema\.json$/);
  });
});
