# Phase 15: Concurrent Runs & Context Handoff

## Purpose

Two findings from the v1 pre-flight review motivate this phase:

1. **Concurrent runs against distinct feature branches are *almost* supported,
   but have two sharp edges** that prevent the workflow from being claimed in
   the docs: task default branches are namespaced by plan name (not runId or
   featureBranch), so two runs of the same plan collide on `<plan-name>/<task-id>`;
   and runIds use millisecond resolution (`run-${Date.now().toString(36)}`),
   so two runs kicked off in the same tick get the same id. The merge path
   already uses git plumbing and atomic ref CAS — the bones are right — but
   the naming layer has to catch up before "two yaao runs against two feature
   branches simultaneously" can be a documented, tested workflow.
2. **The parent→child context handoff is correct but lossy.** A dependent
   agent today receives an 80-line stdout tail, a file list, a single commit
   subject, and the parent's branch — but **not** the parent's task prompt,
   **not** the validation outcome, and only `--numstat`-shaped diff totals
   instead of any per-file shape. The child's worktree branches off the parent
   so the actual code is on disk; the gap is in the *meta-context* (why was
   this done, did it pass validation, what changed semantically). Two of the
   four fixes are tiny.

This phase ships both. Concurrency hardening is a small surface-area change
with a high reliability return; context enrichment is a fixed-size addition
to one artifact (`context.md`) with no new schema surface.

## Features

| Feature | Description | Doc |
| --- | --- | --- |
| **F15.1** | Concurrent-run isolation hardening — runId entropy + branch namespacing | [F15.1-concurrent-run-isolation.md](F15.1-concurrent-run-isolation.md) |
| **F15.2** | Concurrency model — docs alignment + integration tests | [F15.2-concurrency-model.md](F15.2-concurrency-model.md) |
| **F15.3** | Context handoff enrichment (parent prompt, validation, commit chain, diff stat) | [F15.3-context-handoff.md](F15.3-context-handoff.md) |

## Why now

Phase 14 (release polish) tightens the *single-run* first-use story. Phase 15
unlocks the workflow the engine was always shaped for but never actually
claimed: **two agents-on-feature-branches running side by side**, both safely
auto-merging into their own integration branch with no cross-talk. That is
the killer demo for the worktree model — without it, yaao reads as "one big
parallel run" rather than "your background process queue for AI coding."

F15.3 is sequenced into the same phase because the review surfaced both gaps
at the same time and they ship in the same window. They share no code, but
they share a release: v1 lands with concurrent runs + richer handoff.

## Implementation order

1. **F15.1** first — pure plumbing, no schema or API change. Unblocks F15.2's
   integration tests.
2. **F15.2** second — wires the tests that prove the workflow and aligns the
   docs (Phase 12 internal docs claim a `.yaao/.lock` that doesn't exist in
   `src/`; we either build it or remove the claim — the latter, since the
   workflow we *want* is concurrency, not serialization).
3. **F15.3** last — orthogonal to F15.1/F15.2 and can land in parallel, but
   sequenced after so the phase's first PR is small and reviewable.

## Out of scope

- **Cross-run merge serialization.** Two runs auto-merging into the *same*
  target branch (e.g. both straight into `main`, no feature branch) is
  protected by atomic `update-ref` CAS today — the second one gets a
  `task:merge-failed` event. Adding a per-target advisory lock to give those
  runs a friendlier retry experience is a v2 idea, not a v1 gating concern.
- **Cross-process project lock.** The phase-12 docs imply a `.yaao/.lock`
  that serializes `yaao_run` invocations on one MCP server. We're explicitly
  *not* adding that lock — the workflow the user wants is concurrent runs,
  not queueing — and F15.2 removes the doc claim.
- **Streaming the full agent transcript into the handoff.** F15.3 enriches
  `context.md` with bounded, high-signal additions. Forwarding the entire
  tool-use trace or thinking blocks would blow past the token budget. The
  journal + web viewer remain the place to inspect a parent's full activity.
- **A `yaao runs` command.** Cross-run inspection lives in `yaao_inspect` /
  `yaao status` / the web viewer's Workspace page; we're not adding a new
  CLI surface.
