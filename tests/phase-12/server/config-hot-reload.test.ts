import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startConfigWatcher } from '../../../src/mcp/server.js';
import { yaaoInspectTool, type ToolContext } from '../../../src/mcp/tools.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

function untilBaseBranch(ctx: ToolContext, expected: string, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async (): Promise<void> => {
      const r = await yaaoInspectTool({}, ctx);
      const ws = r.structuredContent['workspace'] as { baseBranch: string };
      if (ws.baseBranch === expected) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`timed out; baseBranch=${ws.baseBranch}`));
      }
      setTimeout(() => void tick(), 25);
    };
    void tick();
  });
}

function writeConfig(root: string, baseBranch: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, '.yaao', 'yaao.config.json'),
    JSON.stringify({ version: 1, defaults: { 'base-branch': baseBranch } }, null, 2),
  );
}

describe('config hot reload', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('reloads yaao.config.json on disk change so subsequent tool calls see live values', async () => {
    project = createTmpProject();
    mkdirSync(join(project.path, '.yaao'), { recursive: true });
    writeConfig(project.path, 'main');

    // Initial config the way `serve()` would load it.
    const { loadConfig } = await import('../../../src/config/loader.js');
    const initial = await loadConfig({ cwd: project.path, env: process.env });
    const ctx: ToolContext = { cwd: project.path, config: initial.config };

    // Baseline: inspect sees the initial baseBranch from the on-disk file.
    const baseline = await yaaoInspectTool({}, ctx);
    expect(
      (baseline.structuredContent['workspace'] as { baseBranch: string }).baseBranch,
    ).toBe('main');

    // Start the watcher. Small debounce so the test doesn't have to wait
    // the production default. macOS FSEvents has its own cold-start delay,
    // so we poll until the new value is observed.
    const watcher = startConfigWatcher(ctx, { cwd: project.path, debounceMs: 10 });
    watcher.start();
    try {
      // Edit the config on disk — the same shape the reviewer's repro uses.
      await new Promise((r) => setTimeout(r, 100));
      writeConfig(project.path, 'feature/serial');

      // Without the watcher fix, this hangs forever — the cached config
      // serves stale values until restart. With the fix, the very next
      // tool call sees the new baseBranch.
      await untilBaseBranch(ctx, 'feature/serial');
    } finally {
      watcher.stop();
    }
  });

  it('keeps the previous config when a write produces invalid JSON', async () => {
    project = createTmpProject();
    mkdirSync(join(project.path, '.yaao'), { recursive: true });
    writeConfig(project.path, 'main');

    const { loadConfig } = await import('../../../src/config/loader.js');
    const initial = await loadConfig({ cwd: project.path, env: process.env });
    const ctx: ToolContext = { cwd: project.path, config: initial.config };

    const errors: Error[] = [];
    const watcher = startConfigWatcher(ctx, {
      cwd: project.path,
      debounceMs: 10,
      onError: (e) => errors.push(e),
    });
    watcher.start();
    try {
      await new Promise((r) => setTimeout(r, 100));
      // Truncated / mid-keystroke save. Common editor behaviour.
      writeFileSync(join(project.path, '.yaao', 'yaao.config.json'), '{ "version": 1, "default');
      // Settle past the debounce window.
      await new Promise((r) => setTimeout(r, 100));
      // Old config preserved: the agent didn't get blown out mid-edit.
      const r = await yaaoInspectTool({}, ctx);
      expect((r.structuredContent['workspace'] as { baseBranch: string }).baseBranch).toBe('main');
      // onError fired so the caller can log / surface if it wants.
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      watcher.stop();
    }
  });

  it('start/stop is idempotent and tolerates a missing config dir', () => {
    project = createTmpProject();
    // No .yaao/ yet — watcher should be a no-op rather than crashing.
    const ctx: ToolContext = { cwd: project.path, config: DEFAULT_CONFIG };
    const w = startConfigWatcher(ctx, { cwd: project.path, debounceMs: 1 });
    w.start();
    w.start(); // idempotent
    w.stop();
    w.stop(); // idempotent
    expect(true).toBe(true);
  });
});
