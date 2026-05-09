import { SubprocessBackend, type LineParser } from './subprocess.js';
import type { AgentEvent, SpawnOptions } from './backend.js';
import { nowIso } from './backend.js';

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
}
