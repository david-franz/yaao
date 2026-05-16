import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubprocessBackend, type LineParser } from './subprocess.js';
import type { AgentEvent, McpServerConfig, SpawnOptions } from './backend.js';
import { nowIso } from './backend.js';

export interface ClaudeCodeBackendOptions {
  bin?: string;
}

const MODEL_ALIASES: Record<string, string> = {
  opus: 'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

export function resolveClaudeModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return MODEL_ALIASES[model] ?? model;
}

export function buildClaudeArgs(opts: SpawnOptions, mcpConfigPath?: string): string[] {
  // `--verbose` is required by the current `claude` CLI when combining
  // `--print` with `--output-format stream-json`.
  //
  // Permission mode maps to claude's `--permission-mode`:
  //   ask         → default  (interactive prompts; useless under --print)
  //   allow-edits → acceptEdits (file writes auto-approved, bash still prompts)
  //   allow-all   → bypassPermissions (everything auto-approved)
  //
  // `acceptEdits` keeps the agent from hanging on file confirmations but it
  // still gets stuck on bash commands like `npm install`. `yaao run` defaults
  // tasks to `allow-all` because worktrees are isolated and the user has
  // already opted in by launching the run; per-task overrides are available
  // via the plan.
  const claudeMode =
    opts.permissions === 'ask'
      ? 'default'
      : opts.permissions === 'allow-edits'
        ? 'acceptEdits'
        : 'bypassPermissions';
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    claudeMode,
  ];
  const model = resolveClaudeModel(opts.model);
  if (model) {
    args.push('--model', model);
  }
  if (mcpConfigPath) {
    args.push('--mcp-config', mcpConfigPath);
  }
  if (opts.systemPrompt) {
    args.push('--append-system-prompt', opts.systemPrompt);
  }
  // Skills are not passed as CLI flags — the current `claude` binary doesn't have
  // `--skill`. Skill content reaches the agent via:
  //   1. the yaao MCP server (Phase 12) → `yaao_skill_<name>` tool calls; and
  //   2. the `.claude/CLAUDE.md` managed block written by the Phase 8 emitter.
  // The `opts.skills` list is kept on `SpawnOptions` for the API backend, which
  // builds the request body directly.
  return args;
}

interface StreamJsonBlock {
  type: string;
  content?: { type: string; text?: string; name?: string; input?: unknown }[];
  message?: { content?: { type: string; text?: string; name?: string; input?: unknown }[] };
  text?: string;
}

export function parseClaudeStreamJsonLine(line: string): AgentEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let parsed: StreamJsonBlock;
  try {
    parsed = JSON.parse(trimmed) as StreamJsonBlock;
  } catch {
    // not JSON; emit as raw stdout so the user still sees it
    return { type: 'stdout', data: line, timestamp: nowIso() };
  }
  // assistant message with content blocks
  const blocks = parsed.message?.content ?? parsed.content;
  if (Array.isArray(blocks)) {
    for (const b of blocks) {
      if (b.type === 'tool_use') {
        return {
          type: 'tool-use',
          data: JSON.stringify({ name: b.name, input: b.input }),
          timestamp: nowIso(),
        };
      }
      if (b.type === 'text' && typeof b.text === 'string') {
        return { type: 'stdout', data: b.text, timestamp: nowIso() };
      }
      if (b.type === 'thinking' && typeof b.text === 'string') {
        return { type: 'thinking', data: b.text, timestamp: nowIso() };
      }
    }
  }
  if (parsed.type === 'error') {
    return { type: 'stderr', data: trimmed, timestamp: nowIso() };
  }
  if (typeof parsed.text === 'string') {
    return { type: 'stdout', data: parsed.text, timestamp: nowIso() };
  }
  return undefined;
}

const claudeStreamParser: LineParser = (line) => parseClaudeStreamJsonLine(line);

export class ClaudeCodeBackend extends SubprocessBackend {
  private mcpConfigPath: string | undefined;
  private mcpDir: string | undefined;

  constructor(opts: ClaudeCodeBackendOptions = {}) {
    super({
      name: 'claude-code',
      bin: opts.bin ?? 'claude',
      buildArgs: () => [],
      parseStdout: claudeStreamParser,
      promptOnStdin: true,
    });
  }

  override async spawn(spawnOpts: SpawnOptions) {
    this.mcpConfigPath = writeMcpConfig(spawnOpts.mcpServers);
    this.mcpDir = this.mcpConfigPath ? join(this.mcpConfigPath, '..') : undefined;
    // Override the buildArgs at spawn time to include the mcp config path.
    (this.opts as { buildArgs: (o: SpawnOptions) => string[] }).buildArgs = (o) =>
      buildClaudeArgs(o, this.mcpConfigPath);
    const proc = await super.spawn(spawnOpts);
    const cleanup = () => {
      if (this.mcpDir) {
        try {
          rmSync(this.mcpDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
        this.mcpDir = undefined;
        this.mcpConfigPath = undefined;
      }
    };
    proc.completed.then(cleanup, cleanup);
    return proc;
  }
}

export function writeMcpConfig(servers: McpServerConfig[] | undefined): string | undefined {
  if (!servers || servers.length === 0) return undefined;
  const dir = mkdtempSync(join(tmpdir(), 'yaao-mcp-'));
  const path = join(dir, 'mcp.json');
  const obj: Record<string, unknown> = { mcpServers: {} };
  for (const s of servers) {
    (obj['mcpServers'] as Record<string, unknown>)[s.name] = {
      command: s.command,
      args: s.args ?? [],
      env: s.env ?? {},
    };
  }
  writeFileSync(path, JSON.stringify(obj, null, 2));
  return path;
}
