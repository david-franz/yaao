import type { YaaoConfig, AgentName } from '../config/types.js';
import type { AgentBackend, AvailabilityReport } from './backend.js';
import { ClaudeCodeBackend } from './claude-code.js';
import { CursorBackend } from './cursor.js';
import { CopilotBackend } from './copilot.js';
import { CodexBackend } from './codex.js';
import { ApiBackend, AnthropicProvider } from './api/backend.js';

export interface AgentAvailability {
  byName: Map<AgentName, AvailabilityReport>;
}

const cache = new Map<string, Promise<AgentAvailability>>();

export interface DetectOptions {
  noCache?: boolean;
  /** Override factory used by tests to inject FakeBackend instances. */
  factory?: (cfg: YaaoConfig) => AgentBackend[];
}

export async function detectAgents(config: YaaoConfig, opts: DetectOptions = {}): Promise<AgentAvailability> {
  const key = JSON.stringify(config.agents);
  if (!opts.noCache && cache.has(key)) {
    return cache.get(key) as Promise<AgentAvailability>;
  }
  const promise = doDetect(config, opts);
  if (!opts.noCache) cache.set(key, promise);
  return promise;
}

export function clearAgentCache(): void {
  cache.clear();
}

async function doDetect(config: YaaoConfig, opts: DetectOptions): Promise<AgentAvailability> {
  const backends = (opts.factory ?? defaultFactory)(config);
  const probe = (b: AgentBackend): Promise<[AgentName, AvailabilityReport]> =>
    b
      .isAvailable()
      .then((r): [AgentName, AvailabilityReport] => [b.name, r])
      .catch((err): [AgentName, AvailabilityReport] => [
        b.name,
        { available: false, reason: (err as Error).message },
      ]);
  const results = await Promise.all(backends.map(probe));
  const byName = new Map<AgentName, AvailabilityReport>();
  for (const [name, report] of results) byName.set(name, report);
  return { byName };
}

function defaultFactory(cfg: YaaoConfig): AgentBackend[] {
  const out: AgentBackend[] = [];
  const a = cfg.agents as unknown as Record<
    string,
    { enabled?: boolean; bin?: string } | undefined
  >;
  if (a['claude-code']?.enabled !== false) {
    out.push(new ClaudeCodeBackend({ bin: a['claude-code']?.bin }));
  }
  if (a['cursor']?.enabled !== false) {
    out.push(new CursorBackend({ bin: a['cursor']?.bin }));
  }
  if (a['copilot']?.enabled !== false) {
    out.push(new CopilotBackend({ bin: a['copilot']?.bin }));
  }
  if (a['codex']?.enabled !== false) {
    out.push(new CodexBackend({ bin: a['codex']?.bin }));
  }
  // The api backend reports availability per-provider; here we surface it once with
  // the first configured provider key so `yaao agents` shows it.
  const providers = cfg.agents.api.providers;
  const firstKey = Object.values(providers)[0]?.['api-key'];
  out.push(new ApiBackend({ provider: new AnthropicProvider(), apiKey: firstKey }));
  return out;
}
