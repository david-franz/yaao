import { nanoid } from 'nanoid';

/**
 * F16.1 — runId entropy.
 *
 * The pre-F16.1 shape was `run-${Date.now().toString(36)}` — millisecond
 * resolution. Two MCP-driven `yaao_run` calls fired in the same tick (a
 * real workflow: kick off two runs against two feature branches from the
 * same MCP client) collided on the runId, which produced collisions on
 * disk (worktree path: `.yaao/worktrees/<runId>/<taskId>`) and in the
 * journal directory.
 *
 * The new shape adds a 6-character nanoid suffix:
 *
 *     run-${Date.now().toString(36)}-${nanoid(6)}
 *
 * 6 alphanumeric characters give ~10⁹ values per millisecond — enough
 * collision resistance that two runs fired in the same tick are safe.
 *
 * The runId remains a stable string safe in file paths (no separators,
 * no shell-surprising characters). Existing journals keyed by the old
 * shape stay readable — this is a forward-only change.
 */
export function generateRunId(): string {
  return `run-${Date.now().toString(36)}-${nanoid(6)}`;
}
