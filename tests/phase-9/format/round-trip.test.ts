import { describe, it, expect } from 'vitest';
import { parseMarkdownPlan, serializeMarkdownPlan } from '../../../src/planner/markdown.js';

const SAMPLE = `# Add OAuth2 login

> Add Google and GitHub providers behind a unified /auth surface.

## Metadata

- name: oauth
- scope: feature
- created: 2026-05-08

## Tasks

| id        | title                | depends      | agent (suggested) | model (suggested) |
|-----------|----------------------|--------------|-------------------|-------------------|
| scaffold  | Scaffold the OAuth module | | claude-code | opus |
| api       | OAuth callback API   | scaffold     | claude-code       |  |
| ui        | Login UI             | scaffold     | claude-code       |  |
| tests     | E2E tests            | api, ui      | claude-code       |  |

## scaffold — Scaffold the OAuth module

Create the directory layout and provider stubs.

### Files
- src/auth/oauth.ts (added)
- src/auth/google.ts (added)

### Validation
- \`npx tsc --noEmit\`

## api — OAuth callback API

Implement /auth/google/callback and /auth/github/callback.

## ui — Login UI

Add a Login component with Google and GitHub buttons.

## tests — E2E tests

Add integration tests covering the happy path through both providers.
`;

describe('markdown plan round-trip', () => {
  it('parses the sample and re-serializes without losing tasks or fields', () => {
    const parsed = parseMarkdownPlan(SAMPLE);
    expect(parsed.title).toBe('Add OAuth2 login');
    expect(parsed.metadata.scope).toBe('feature');
    expect(parsed.tasks).toHaveLength(4);
    const scaffold = parsed.tasks.find((t) => t.id === 'scaffold');
    expect(scaffold?.agent).toBe('claude-code');
    expect(scaffold?.model).toBe('opus');
    expect(scaffold?.depends).toEqual([]);
    expect(scaffold?.files).toContain('src/auth/oauth.ts');
    expect(scaffold?.validation).toBe('npx tsc --noEmit');

    const tests = parsed.tasks.find((t) => t.id === 'tests');
    expect(tests?.depends).toEqual(['api', 'ui']);

    // Re-serialize and re-parse — should match.
    const re = serializeMarkdownPlan(parsed);
    const reparsed = parseMarkdownPlan(re);
    expect(reparsed.tasks).toHaveLength(parsed.tasks.length);
    expect(reparsed.tasks.map((t) => t.id)).toEqual(parsed.tasks.map((t) => t.id));
  });
});
