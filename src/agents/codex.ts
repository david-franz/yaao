import { SubprocessBackend, type LineParser } from './subprocess.js';
import type { AgentEvent, AgentProcess, SpawnOptions } from './backend.js';
import { nowIso } from './backend.js';
import { writeCodexOverlay, type OverlayHandle } from './mcp-overlay.js';

export interface CodexBackendOptions {
  bin?: string;
}

export function buildCodexArgs(opts: SpawnOptions): string[] {
  // The Codex CLI accepts a JSON-stream output mode; we run it non-interactively and
  // pipe the prompt on stdin.
  const args = ['exec', '--json'];
  if (opts.model) {
    args.push('--model', opts.model);
  }
  return args;
}

interface CodexJsonEvent {
  type?: string;
  text?: string;
  message?: string;
  tool?: string;
  tool_name?: string;
  input?: unknown;
  thinking?: string;
}

export function parseCodexJsonLine(line: string): AgentEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as CodexJsonEvent;
    if (parsed.type === 'tool_call' || parsed.tool_name || parsed.tool) {
      return {
        type: 'tool-use',
        data: JSON.stringify({ name: parsed.tool ?? parsed.tool_name, input: parsed.input }),
        timestamp: nowIso(),
      };
    }
    if (parsed.type === 'thinking' && typeof parsed.thinking === 'string') {
      return { type: 'thinking', data: parsed.thinking, timestamp: nowIso() };
    }
    if (parsed.type === 'error' && typeof parsed.message === 'string') {
      return { type: 'stderr', data: parsed.message, timestamp: nowIso() };
    }
    if (typeof parsed.text === 'string') {
      return { type: 'stdout', data: parsed.text, timestamp: nowIso() };
    }
  } catch {
    return { type: 'stdout', data: line, timestamp: nowIso() };
  }
  return undefined;
}

const codexParser: LineParser = (line) => parseCodexJsonLine(line);

export class CodexBackend extends SubprocessBackend {
  constructor(opts: CodexBackendOptions = {}) {
    super({
      name: 'codex',
      bin: opts.bin ?? 'codex',
      buildArgs: (o) => buildCodexArgs(o),
      parseStdout: codexParser,
      promptOnStdin: true,
    });
  }

  override async spawn(spawnOpts: SpawnOptions): Promise<AgentProcess> {
    // F14.2: write a per-spawn TOML overlay at .yaao/codex-mcp-overlay.toml
    // inside the worktree so Codex can see per-run MCP servers. Codex's CLI
    // does not currently accept a config-file flag (F14.7's reality check
    // will pin down the actual mechanism), but the overlay is a stable,
    // visible deliverable in the worktree even if the CLI doesn't read it
    // yet — see F14.2 doc for the rationale.
    const overlay = writeCodexOverlay({
      cwd: spawnOpts.cwd,
      mcpServers: spawnOpts.mcpServers ?? [],
    });
    return withOverlayCleanup(await super.spawn(spawnOpts), overlay);
  }
}

function withOverlayCleanup(proc: AgentProcess, overlay: OverlayHandle | undefined): AgentProcess {
  if (!overlay) return proc;
  const cleanup = (): void => overlay.restore();
  proc.completed.then(cleanup, cleanup);
  return proc;
}
