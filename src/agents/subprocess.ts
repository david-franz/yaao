import { execa } from 'execa';
import {
  AgentCancelledError,
  AgentNonZeroExitError,
  AgentTimeoutError,
  AgentUnavailableError,
  YaaoError,
} from '../log/errors.js';
import type {
  AgentBackend,
  AgentEvent,
  AgentName,
  AgentProcess,
  AgentResult,
  AvailabilityReport,
  SpawnOptions,
} from './backend.js';
import { EventQueue, nowIso } from './backend.js';

export type LineParser = (line: string) => AgentEvent | undefined;

export interface SubprocessBackendOptions {
  name: AgentName;
  bin: string;
  /** Pure: produces argv given spawn options. */
  buildArgs: (opts: SpawnOptions) => string[];
  /** Optional: parses stdout text into AgentEvents. Default: one stdout event per line. */
  parseStdout?: LineParser;
  /** Optional: parses stderr text into AgentEvents. Default: one stderr event per line. */
  parseStderr?: LineParser;
  /** Optional: writes the prompt to stdin. Default: true. Some agents take prompt via flag. */
  promptOnStdin?: boolean;
  /** Optional: extra env vars (merged into opts.env). */
  baseEnv?: Record<string, string>;
}

/**
 * Generic subprocess-based agent backend. Each concrete CLI backend (Claude Code, Cursor,
 * Copilot, Codex) plugs into this with a `buildArgs`, an optional output parser, and a
 * binary name.
 */
export class SubprocessBackend implements AgentBackend {
  readonly name: AgentName;
  protected readonly opts: SubprocessBackendOptions;

  constructor(opts: SubprocessBackendOptions) {
    this.opts = opts;
    this.name = opts.name;
  }

  async isAvailable(): Promise<AvailabilityReport> {
    try {
      const r = await execa(this.opts.bin, ['--version'], { reject: false });
      const code = typeof r.exitCode === 'number' ? r.exitCode : -1;
      if (code !== 0) {
        return {
          available: false,
          reason: `${this.opts.bin} --version exited ${code}`,
        };
      }
      const out = (r.stdout?.toString() ?? '').trim();
      return { available: true, version: parseVersionString(out) };
    } catch (err) {
      return { available: false, reason: (err as Error).message };
    }
  }

  async spawn(spawnOpts: SpawnOptions): Promise<AgentProcess> {
    const avail = await this.isAvailable();
    if (!avail.available) {
      throw new AgentUnavailableError({
        message: `agent '${this.name}' is unavailable: ${avail.reason ?? 'unknown'}`,
        agent: this.name,
      });
    }

    const args = this.opts.buildArgs(spawnOpts);
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.opts.baseEnv, ...spawnOpts.env };
    const promptOnStdin = this.opts.promptOnStdin !== false;

    const queue = new EventQueue<AgentEvent>();
    const start = Date.now();
    const parseStdout = this.opts.parseStdout ?? defaultLineParser('stdout');
    const parseStderr = this.opts.parseStderr ?? defaultLineParser('stderr');
    let stdoutBuf = '';
    let stderrBuf = '';
    let toolUseCount = 0;

    const child = execa(this.opts.bin, args, {
      cwd: spawnOpts.cwd,
      env,
      reject: false,
      stdio: [promptOnStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });

    let cancelled: AgentCancelledError | undefined;
    let timedOut: AgentTimeoutError | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (spawnOpts.timeout) {
      timer = setTimeout(() => {
        timedOut = new AgentTimeoutError({
          message: `agent '${this.name}' timed out after ${spawnOpts.timeout}ms`,
          agent: this.name,
          timeoutMs: spawnOpts.timeout ?? 0,
        });
        killTree(child);
      }, spawnOpts.timeout);
    }

    if (spawnOpts.signal) {
      const onAbort = () => {
        cancelled = new AgentCancelledError({
          message: `agent '${this.name}' cancelled`,
          agent: this.name,
        });
        killTree(child);
      };
      if (spawnOpts.signal.aborted) onAbort();
      else spawnOpts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const consumeStream = (
      stream: NodeJS.ReadableStream | null | undefined,
      kind: 'stdout' | 'stderr',
    ) => {
      if (!stream) return;
      let leftover = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        if (kind === 'stdout') stdoutBuf += chunk;
        else stderrBuf += chunk;
        const combined = leftover + chunk;
        const lines = combined.split(/\r?\n/);
        leftover = lines.pop() ?? '';
        for (const line of lines) {
          if (!line) continue;
          const ev = (kind === 'stdout' ? parseStdout : parseStderr)(line);
          if (ev) {
            if (ev.type === 'tool-use') toolUseCount += 1;
            queue.push(ev);
          }
        }
      });
      stream.on('end', () => {
        if (leftover) {
          const ev = (kind === 'stdout' ? parseStdout : parseStderr)(leftover);
          if (ev) {
            if (ev.type === 'tool-use') toolUseCount += 1;
            queue.push(ev);
          }
        }
      });
    };
    consumeStream(child.stdout, 'stdout');
    consumeStream(child.stderr, 'stderr');

    if (promptOnStdin && child.stdin) {
      child.stdin.end(spawnOpts.prompt);
    }

    const completed = (async (): Promise<AgentResult> => {
      const result = await child;
      if (timer) clearTimeout(timer);
      queue.finish();
      const exitCode = typeof result.exitCode === 'number' ? result.exitCode : -1;
      if (timedOut) throw timedOut;
      if (cancelled) throw cancelled;
      if (exitCode !== 0 && exitCode !== null) {
        throw new AgentNonZeroExitError({
          message: `agent '${this.name}' exited ${exitCode}: ${stderrBuf.trim() || '(no stderr)'}`,
          agent: this.name,
          exitCode,
        });
      }
      return {
        exitCode,
        stdout: stdoutBuf,
        stderr: stderrBuf,
        toolUseCount,
        mcpToolCalls: [],
        durationMs: Date.now() - start,
      };
    })();

    return {
      pid: child.pid,
      events: queue,
      completed: completed.catch((err) => {
        if (err instanceof YaaoError) throw err;
        throw err;
      }),
      cancel: async (reason) => {
        cancelled = new AgentCancelledError({
          message: `agent '${this.name}' cancelled${reason ? `: ${reason}` : ''}`,
          agent: this.name,
          reason,
        });
        killTree(child);
      },
    };
  }
}

function defaultLineParser(kind: 'stdout' | 'stderr'): LineParser {
  return (line: string): AgentEvent => ({ type: kind, data: line, timestamp: nowIso() });
}

interface KillableChild {
  pid?: number;
  kill: (signal?: NodeJS.Signals | number) => boolean;
}

function killTree(child: KillableChild): void {
  if (!child.pid) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // ignore
  }
  setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }, 5000).unref();
}

/**
 * Pull a semver-ish token out of a `--version` output. Real CLIs vary wildly:
 *   - `1.2.3 (Claude Code)` (claude)
 *   - `cursor-agent 0.45.1` (cursor)
 *   - `gh version 2.62.0 (2024-..)` (gh)
 *   - `codex 0.10.0`
 *
 * We prefer the first `\d+\.\d+\.\d+[\w.-]*` match; if that fails we fall back to the
 * first whitespace-delimited token. Stripping a leading `v` keeps display tidy.
 */
export function parseVersionString(text: string): string | undefined {
  if (!text) return undefined;
  const m = text.match(/(\d+\.\d+(?:\.\d+)?[\w.-]*)/);
  if (m && m[1]) return m[1];
  const first = text.split(/\s+/)[0];
  if (!first) return undefined;
  return first.replace(/^v/i, '');
}
