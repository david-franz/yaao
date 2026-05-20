// Browser-side API client. Thin wrappers over fetch + SSE so individual
// pages don't have to repeat the request boilerplate.
//
// All responses come back as the envelope shape `{ok, errors?, ...}` from
// F13.1's routes; this module just types the success branch for each
// endpoint. Pages handle ok:false explicitly.

export type Health = { ok: boolean; version: string; cwd: string };

export interface WorkspacePlan {
  slug: string;
  planPath?: string;
  planHash?: string;
  planMtimeMs?: number;
  tracked?: boolean;
  dirty?: boolean;
  planCommit?: string | null;
  execPath?: string;
  execHash?: string;
  execMtimeMs?: number;
  execTracked?: boolean;
  execCommit?: string | null;
  /** Per-plan integration branch from plan.featureBranch (yaml). null when absent. */
  featureBranch?: string | null;
  lastRunId?: string;
  lastRunStatus?: string;
  lastRunEndedAt?: string;
}

export interface WorkspaceRun {
  runId: string;
  planSlug: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  tasksTotal: number;
  tasksCompleted: number;
  tasksFailed: number;
  tasksSkipped: number;
  worktreeRoot: string;
  branchesAlive: string[];
}

export interface InspectPayload {
  ok: boolean;
  workspace: {
    cwd: string;
    configPath: string | null;
    baseBranch: string;
    defaultAgent: string;
    worktreeRoot: string;
    inRepo: boolean;
  };
  plans: WorkspacePlan[];
  runs: WorkspaceRun[];
}

export interface ResolvedPlanResp {
  ok: boolean;
  slug: string;
  path: string;
  plan: {
    plan: { name: string; version: number; description?: string };
    tasks: ResolvedTask[];
  };
}

export interface ResolvedTask {
  id: string;
  title: string;
  prompt: string;
  depends: string[];
  agent: string;
  model?: string;
  skills: string[];
  files: string[];
  retries: number;
  merge: { strategy?: string; into?: string; when?: string };
  validation?: { command: string; 'must-pass'?: boolean };
}

export interface RunSummaryShape {
  ok: boolean;
  runId: string;
  status: string;
  planFile: string;
  planHash: string;
  planCommit?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  tasks: Record<string, RunSummaryTask>;
}

export interface RunSummaryTask {
  status: string;
  agent?: string;
  branch?: string;
  worktree?: string;
  durationMs?: number;
  filesChanged?: number;
  commit?: string;
  mergeStatus?: 'merged' | 'merge-failed';
  mergeInto?: string;
  mergeCommit?: string;
  mergeConflicts?: string[];
  mergeReason?: string;
  cachedFromRunId?: string;
  validation?: {
    command?: string;
    exitCode?: number;
    durationMs?: number;
    decisionReason?: 'exit-code';
    mustPass?: boolean;
    stdoutTail?: string;
    stderrTail?: string;
  };
  error?: { code: string; message: string };
  skipReason?: 'depFailed' | 'filtered';
}

export interface PruneRequest {
  target: 'run' | 'plan' | 'all-completed' | 'all-failed' | 'older-than';
  runId?: string;
  planSlug?: string;
  olderThanDays?: number;
  scope?: ('worktrees' | 'branches' | 'runs')[];
  dryRun?: boolean;
  force?: boolean;
}

export interface PruneResponse {
  ok: boolean;
  dryRun: boolean;
  removed: { worktrees: string[]; branches: string[]; runDirs: string[] };
  skipped: { kind: string; path: string; reason: string }[];
  errors: { code: string; message: string; hint?: string }[];
}

export type ResumeRequest = { retryFailed?: boolean; reskip?: boolean };

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok && r.headers.get('content-type')?.includes('application/json') !== true) {
    throw new Error(`${path} → HTTP ${r.status}`);
  }
  return (await r.json()) as T;
}

export const api = {
  health: () => getJson<Health>('/api/health'),
  inspect: () => getJson<InspectPayload>('/api/inspect'),
  plans: () => getJson<{ ok: boolean; plans: { slug: string; path: string; mtimeMs: number }[] }>('/api/plans'),
  plan: (slug: string) => getJson<ResolvedPlanResp>(`/api/plans/${encodeURIComponent(slug)}`),
  planRaw: async (slug: string): Promise<string> => {
    const r = await fetch(`/api/plans/${encodeURIComponent(slug)}/raw`);
    if (!r.ok) throw new Error(`/api/plans/${slug}/raw → HTTP ${r.status}`);
    return r.text();
  },
  putPlanRaw: async (slug: string, body: string): Promise<PutPlanResp> => {
    const r = await fetch(`/api/plans/${encodeURIComponent(slug)}/raw`, {
      method: 'PUT',
      headers: { 'content-type': 'application/x-yaml' },
      body,
    });
    return (await r.json()) as PutPlanResp;
  },
  runs: () => getJson<{ ok: boolean; runs: { runId: string; status: string; startedAt: string; planFile: string; tasks: Record<string, { status: string }> }[] }>('/api/runs'),
  run: (runId: string) => getJson<RunSummaryShape>(`/api/runs/${encodeURIComponent(runId)}`),
  prune: async (req: PruneRequest): Promise<PruneResponse> => {
    const r = await fetch('/api/prune', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
    return (await r.json()) as PruneResponse;
  },
  resume: async (runId: string, req: ResumeRequest = {}): Promise<RunSummaryShape> => {
    const r = await fetch(`/api/runs/${encodeURIComponent(runId)}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
    return (await r.json()) as RunSummaryShape;
  },
  cancel: async (runId: string): Promise<{ ok: boolean; runId?: string; signaled?: boolean; reason?: string; pid?: number; hint?: string }> => {
    const r = await fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
    return (await r.json()) as { ok: boolean; runId?: string; signaled?: boolean; reason?: string; pid?: number; hint?: string };
  },
  configRaw: async (): Promise<string> => {
    const r = await fetch('/api/config/raw');
    return r.text();
  },
  putConfigRaw: async (body: string): Promise<PutConfigResp> => {
    const r = await fetch('/api/config/raw', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body,
    });
    return (await r.json()) as PutConfigResp;
  },
  config: () => getJson<{ ok: boolean; config: unknown; path: string | null }>('/api/config'),
  configSchema: () => getJson<unknown>('/api/config/schema'),
};

export interface PutPlanResp {
  ok: boolean;
  path?: string;
  errors?: { code: string; message: string }[];
}
export interface PutConfigResp {
  ok: boolean;
  path?: string;
  errors?: { code: string; message: string }[];
}

/**
 * Subscribe to an SSE endpoint. Returns a cleanup function. Auto-reconnects
 * on transport drop (browser EventSource does this natively, but we keep
 * the callback shape so caller code is identical for SSE and one-off fetches).
 */
export function subscribe(
  path: string,
  handlers: { [eventName: string]: (data: unknown, lastId?: string) => void },
  opts: { withCredentials?: boolean } = {},
): () => void {
  const es = new EventSource(path, opts);
  for (const [name, cb] of Object.entries(handlers)) {
    es.addEventListener(name, (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as unknown;
        cb(data, (ev as MessageEvent).lastEventId);
      } catch {
        // Surface raw text frames as-is if they aren't JSON.
        cb((ev as MessageEvent).data, (ev as MessageEvent).lastEventId);
      }
    });
  }
  return () => es.close();
}
