import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isOptedIn, hasBinary, hasEnvVar, liveTestGate } from './_helpers.js';

const ORIGINAL_ENV = { ...process.env };

describe('F14.4 — live-test gating helpers', () => {
  beforeEach(() => {
    delete process.env['YAAO_LIVE_BACKENDS'];
    delete process.env['YAAO_LIVE_CLAUDE_CODE'];
    delete process.env['YAAO_LIVE_CURSOR'];
    delete process.env['YAAO_LIVE_CODEX'];
    delete process.env['YAAO_LIVE_COPILOT'];
    delete process.env['YAAO_LIVE_ANTHROPIC'];
    delete process.env['YAAO_TEST_FAKE_VAR'];
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('isOptedIn returns ok when YAAO_LIVE_BACKENDS=1', () => {
    process.env['YAAO_LIVE_BACKENDS'] = '1';
    expect(isOptedIn('cursor').ok).toBe(true);
  });

  it('isOptedIn returns ok for a backend-specific opt-in', () => {
    process.env['YAAO_LIVE_CURSOR'] = '1';
    const r = isOptedIn('cursor');
    expect(r.ok).toBe(true);
  });

  it('isOptedIn returns a clear reason when not opted in', () => {
    const r = isOptedIn('cursor');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/YAAO_LIVE_BACKENDS|YAAO_LIVE_CURSOR/);
    }
  });

  it('hasEnvVar passes when set and fails with reason when missing', () => {
    expect(hasEnvVar('YAAO_TEST_FAKE_VAR').ok).toBe(false);
    process.env['YAAO_TEST_FAKE_VAR'] = 'abc';
    expect(hasEnvVar('YAAO_TEST_FAKE_VAR').ok).toBe(true);
  });

  it('hasBinary returns a reason on missing binary', () => {
    const r = hasBinary('/nonexistent/binary/path/yaao-fake');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not found|exited|failed/);
  });

  it('liveTestGate composes opt-in + binary checks', () => {
    // No opt-in: short-circuits with the opt-in reason
    const r1 = liveTestGate('cursor', { ok: true, version: '0.1' });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toMatch(/YAAO_LIVE_BACKENDS|YAAO_LIVE_CURSOR/);

    // Opt in, but a check fails
    process.env['YAAO_LIVE_BACKENDS'] = '1';
    const r2 = liveTestGate('cursor', { ok: false, reason: 'binary missing' });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('binary missing');

    // Opt in and all checks pass
    const r3 = liveTestGate('cursor', { ok: true, version: '0.1' });
    expect(r3.ok).toBe(true);
  });
});
