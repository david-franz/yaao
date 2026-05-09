import type { AgentName } from '../../config/types.js';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  location?: { file: string; line: number; col: number };
  taskId?: string;
  hint?: string;
}

/**
 * Per-backend availability snapshot. F4.7 produces this; until then the validator
 * accepts a best-effort stub (default: every enabled backend is "available").
 */
export interface AgentAvailability {
  available: Record<AgentName, boolean>;
  apiKeys: { anthropic: boolean; openai: boolean; openrouter: boolean };
}

export const ALL_AVAILABLE: AgentAvailability = {
  available: {
    'claude-code': true,
    cursor: true,
    copilot: true,
    codex: true,
    api: true,
  },
  apiKeys: { anthropic: true, openai: true, openrouter: true },
};
