import { execaSync } from 'execa';

/**
 * F14.4 — Skip-if-missing gating for live backend tests.
 *
 * Live tests run only when BOTH:
 *  - the explicit opt-in env var is set (YAAO_LIVE_BACKENDS=1, or
 *    YAAO_LIVE_<backend>=1 for a single backend), AND
 *  - the required binary / API key is available on the host.
 *
 * The two-key model keeps regular CI fast (the default PR run sees the
 * tests but skips them) while letting nightly cron + manual dispatch
 * runs opt in explicitly. The reason returned by isOptedIn / hasBinary
 * is surfaced in the skip message so the test runner's summary tells
 * you exactly what coverage you're losing.
 */

export function isOptedIn(backendKey: string): { ok: true } | { ok: false; reason: string } {
  // A backend-specific opt-in beats the global one (lets a CI matrix run
  // one backend at a time).
  if (process.env[`YAAO_LIVE_${backendKey.toUpperCase()}`] === '1') return { ok: true };
  if (process.env['YAAO_LIVE_BACKENDS'] === '1') return { ok: true };
  return {
    ok: false,
    reason: `set YAAO_LIVE_BACKENDS=1 (or YAAO_LIVE_${backendKey.toUpperCase()}=1) to opt in`,
  };
}

export function hasBinary(bin: string): { ok: true; version: string } | { ok: false; reason: string } {
  try {
    const r = execaSync(bin, ['--version'], { reject: false });
    const code = typeof r.exitCode === 'number' ? r.exitCode : -1;
    if (code !== 0) {
      return { ok: false, reason: `${bin} --version exited ${code}` };
    }
    return { ok: true, version: (r.stdout?.toString() ?? '').trim() || '(unknown)' };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return { ok: false, reason: `${bin} not found on PATH` };
    return { ok: false, reason: `${bin} probe failed: ${(err as Error).message}` };
  }
}

export function hasEnvVar(name: string): { ok: true } | { ok: false; reason: string } {
  if (process.env[name] && process.env[name]!.length > 0) return { ok: true };
  return { ok: false, reason: `${name} env var is not set` };
}

/**
 * Compose a skip reason from multiple gates. Returns ok+all-pass or the
 * first failing reason. Each test calls this in beforeAll / the test
 * body and either runs or test.skip()s with the combined reason.
 */
export function liveTestGate(
  backendKey: string,
  ...checks: ({ ok: true; version?: string } | { ok: false; reason: string })[]
): { ok: true } | { ok: false; reason: string } {
  const opt = isOptedIn(backendKey);
  if (!opt.ok) return opt;
  for (const c of checks) {
    if (!c.ok) return c;
  }
  return { ok: true };
}
