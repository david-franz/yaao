import { describe, it, expect, vi } from 'vitest';
import { resolveCtxSysInjection } from '../../../src/ctx-sys/inject.js';
import { CTX_SYS_DIRECTIVE } from '../../../src/ctx-sys/directive.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import type { YaaoConfig } from '../../../src/config/types.js';
import type { CtxSysStatus } from '../../../src/ctx-sys/detect.js';

function configWith(over: Partial<YaaoConfig['ctx-sys']>, mcp?: YaaoConfig['mcp-servers']): YaaoConfig {
  return {
    ...DEFAULT_CONFIG,
    'ctx-sys': { enabled: true, 'auto-spawn': true, 'require-query': false, ...over },
    'mcp-servers': mcp ?? {},
  };
}

const ok: CtxSysStatus = { installed: true, initialized: true, indexed: true };

describe('resolveCtxSysInjection', () => {
  it('injects a per-agent ctx-sys serve --project entry + directive when enabled and indexed', async () => {
    const r = await resolveCtxSysInjection({
      cwd: '/repo',
      config: configWith({ enabled: true }),
      detect: async () => ok,
    });
    expect(r.mcpServers).toHaveLength(1);
    expect(r.mcpServers[0]?.name).toBe('ctx-sys');
    expect(r.mcpServers[0]?.args).toEqual(['serve', '--project', '/repo']);
    expect(r.directive).toBe(CTX_SYS_DIRECTIVE);
    expect(r.warning).toBeUndefined();
  });

  it('degrades with a warning when the binary is missing (no entry, no directive)', async () => {
    const r = await resolveCtxSysInjection({
      cwd: '/repo',
      config: configWith({ enabled: true }),
      detect: async () => ({ installed: false, initialized: false, reason: 'ctx-sys not found' }),
    });
    expect(r.mcpServers).toEqual([]);
    expect(r.directive).toBeUndefined();
    expect(r.warning).toMatch(/PATH/);
  });

  it('degrades with a warning when the project is not indexed', async () => {
    const r = await resolveCtxSysInjection({
      cwd: '/repo',
      config: configWith({ enabled: true }),
      detect: async () => ({ installed: true, initialized: true, indexed: false }),
    });
    expect(r.mcpServers).toEqual([]);
    expect(r.directive).toBeUndefined();
    expect(r.warning).toMatch(/index/);
  });

  it('does not probe or inject when disabled for the run via --no-ctx-sys', async () => {
    const detect = vi.fn(async () => ok);
    const r = await resolveCtxSysInjection({
      cwd: '/repo',
      config: configWith({ enabled: true }),
      disabledForRun: true,
      detect,
    });
    expect(detect).not.toHaveBeenCalled();
    expect(r.mcpServers).toEqual([]);
    expect(r.directive).toBeUndefined();
    expect(r.warning).toBeUndefined();
  });

  it('stays out entirely when auto-spawn is false (user manages ctx-sys)', async () => {
    const detect = vi.fn(async () => ok);
    const r = await resolveCtxSysInjection({
      cwd: '/repo',
      config: configWith({ enabled: true, 'auto-spawn': false }),
      detect,
    });
    expect(detect).not.toHaveBeenCalled();
    expect(r.mcpServers).toEqual([]);
    expect(r.directive).toBeUndefined();
    expect(r.warning).toBeUndefined();
  });

  it('does nothing when ctx-sys is disabled in config', async () => {
    const detect = vi.fn(async () => ok);
    const r = await resolveCtxSysInjection({
      cwd: '/repo',
      config: configWith({ enabled: false }),
      detect,
    });
    expect(detect).not.toHaveBeenCalled();
    expect(r.mcpServers).toEqual([]);
  });

  it('flows user-declared mcp-servers regardless of ctx-sys, with ctx-sys first', async () => {
    const r = await resolveCtxSysInjection({
      cwd: '/repo',
      config: configWith({ enabled: true }, { 'house-style': { command: 'style-mcp', args: [], env: {} } }),
      detect: async () => ok,
    });
    expect(r.mcpServers.map((s) => s.name)).toEqual(['ctx-sys', 'house-style']);
  });

  it('still flows user mcp-servers when ctx-sys is disabled', async () => {
    const r = await resolveCtxSysInjection({
      cwd: '/repo',
      config: configWith({ enabled: false }, { 'house-style': { command: 'style-mcp', args: [], env: {} } }),
    });
    expect(r.mcpServers.map((s) => s.name)).toEqual(['house-style']);
    expect(r.directive).toBeUndefined();
  });
});
