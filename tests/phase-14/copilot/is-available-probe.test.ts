import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopilotBackend } from '../../../src/agents/copilot.js';

/**
 * F14.7's isAvailable probes four phases via execa. Rather than mock
 * execa (which is awkward at the module boundary in ESM), each test
 * builds a fake `gh` shell script in a tmpdir, points
 * CopilotBackend.bin at it, and asserts the reported reason.
 *
 * The fake gh dispatches on argv to simulate each branch:
 *   gh --version           → emit "gh version 2.88.1"
 *   gh auth status         → exit 0 (authenticated) or 1 (not)
 *   gh extension list      → emit a table including / excluding gh-copilot
 *   gh copilot --version   → emit "gh-copilot 0.5.4" or fail
 */
function makeFakeGh(opts: {
  authOk?: boolean;
  hasCopilotExt?: boolean;
  copilotVersion?: string;
  ghCrashes?: boolean;
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'yaao-fake-gh-'));
  const script = join(dir, 'gh');
  const body = `#!/bin/sh
case "$1" in
  --version)
    ${opts.ghCrashes ? 'exit 7' : 'echo "gh version 2.88.1"'}
    ;;
  auth)
    ${opts.authOk === false ? 'exit 1' : 'exit 0'}
    ;;
  extension)
    ${
      opts.hasCopilotExt === false
        ? 'echo "NAME REPO VERSION"'
        : 'echo "github/gh-copilot  v1.2.3"'
    }
    exit 0
    ;;
  copilot)
    if [ "$2" = "--version" ]; then
      ${opts.copilotVersion ? `echo "${opts.copilotVersion}"; exit 0` : 'exit 2'}
    fi
    ;;
esac
exit 0
`;
  writeFileSync(script, body);
  chmodSync(script, 0o755);
  return script;
}

describe('F14.7 — CopilotBackend.isAvailable four-phase probe', () => {
  it('reports binary-not-on-PATH when gh is missing', async () => {
    const backend = new CopilotBackend({ bin: '/nonexistent/path/yaao-test-no-gh' });
    const r = await backend.isAvailable();
    expect(r.available).toBe(false);
    if (!r.available) expect(r.reason).toMatch(/not found on PATH/);
  });

  it('reports a non-zero gh --version exit cleanly', async () => {
    const fake = makeFakeGh({ ghCrashes: true });
    const backend = new CopilotBackend({ bin: fake });
    const r = await backend.isAvailable();
    expect(r.available).toBe(false);
    if (!r.available) expect(r.reason).toMatch(/--version exited/);
  });

  it('reports unauthenticated when gh auth status fails', async () => {
    const fake = makeFakeGh({ authOk: false });
    const backend = new CopilotBackend({ bin: fake });
    const r = await backend.isAvailable();
    expect(r.available).toBe(false);
    if (!r.available) expect(r.reason).toMatch(/gh auth login/);
  });

  it('reports missing gh-copilot extension with an install hint', async () => {
    const fake = makeFakeGh({ hasCopilotExt: false });
    const backend = new CopilotBackend({ bin: fake });
    const r = await backend.isAvailable();
    expect(r.available).toBe(false);
    if (!r.available) {
      expect(r.reason).toMatch(/gh-copilot extension not installed/);
      expect(r.reason).toMatch(/gh extension install github\/gh-copilot/);
    }
  });

  it('reports available + the Copilot extension version (not gh) when gh copilot --version works', async () => {
    const fake = makeFakeGh({ copilotVersion: 'gh-copilot version 0.5.4' });
    const backend = new CopilotBackend({ bin: fake });
    const r = await backend.isAvailable();
    expect(r.available).toBe(true);
    if (r.available) {
      // F14.7 — the reported version must be the extension's (0.5.4),
      // not the gh binary's (2.88.1). This is the fix for the
      // misleading "✔ copilot v2.88.1" in `yaao agents` output.
      expect(r.version).toBe('0.5.4');
    }
  });

  it('falls back to the gh extension list version row when gh copilot --version is unsupported', async () => {
    // copilotVersion absent → `gh copilot --version` exits 2 → fall
    // back to parsing the `gh extension list` table.
    const fake = makeFakeGh({});
    const backend = new CopilotBackend({ bin: fake });
    const r = await backend.isAvailable();
    expect(r.available).toBe(true);
    if (r.available) expect(r.version).toBe('1.2.3');
  });
});
