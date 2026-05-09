/**
 * Stub config type for F1.2. The full Zod schema and inferred type land in F1.3.
 * Defining the type here lets the CLI scaffold compile before the loader exists.
 */
export interface YaaoConfig {
  $schema?: string;
  version: 1;
  defaults: {
    agent: 'claude-code' | 'cursor' | 'copilot' | 'codex' | 'api';
    model: string;
    'max-parallel': number;
    'base-branch': string;
    'worktree-root': string;
  };
  merge: {
    strategy: 'auto' | 'pr' | 'manual';
    'on-conflict': 'manual' | 'agent';
    'conflict-resolver'?: { agent: string; model: string };
  };
  agents: Record<string, unknown>;
  'ctx-sys': { enabled: boolean; 'auto-spawn': boolean; 'require-query': boolean };
  plan: { format: 'markdown' | 'speckit' | 'both'; speckit: boolean };
}

export const DEFAULT_CONFIG: YaaoConfig = {
  version: 1,
  defaults: {
    agent: 'claude-code',
    model: 'opus',
    'max-parallel': 4,
    'base-branch': 'main',
    'worktree-root': '.yaao/worktrees',
  },
  merge: { strategy: 'auto', 'on-conflict': 'manual' },
  agents: {
    'claude-code': { enabled: true, bin: 'claude' },
    cursor: { enabled: true, bin: 'cursor-agent' },
    copilot: { enabled: true, bin: 'gh' },
    codex: { enabled: true, bin: 'codex' },
    api: { providers: {} },
  },
  'ctx-sys': { enabled: false, 'auto-spawn': true, 'require-query': false },
  plan: { format: 'markdown', speckit: false },
};
