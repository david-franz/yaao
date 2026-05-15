import { describe, it, expect } from 'vitest';
import { parseMarkdownPlan } from '../../../src/planner/markdown.js';
import { serializeSpecKit, parseSpecKit } from '../../../src/planner/speckit.js';

const SAMPLE = `# Add OAuth

> Provider stubs and callbacks.

## Tasks

| id        | title       | depends   | agent (suggested) | model (suggested) |
|-----------|-------------|-----------|-------------------|-------------------|
| scaffold  | Scaffold    |           | claude-code       | opus              |
| api       | API         | scaffold  | claude-code       |                   |

## scaffold — Scaffold

Set up the directory.

### Validation
- \`npx tsc --noEmit\`

## api — API

Implement endpoints.
`;

describe('Spec Kit triplet round-trip', () => {
  it('preserves task ids, deps, and validation across serialize → parse', () => {
    const parsed = parseMarkdownPlan(SAMPLE);
    const triplet = serializeSpecKit(parsed);
    expect(triplet.tasks).toContain('**scaffold**');
    expect(triplet.tasks).toContain('depends: scaffold');
    expect(triplet.tasks).toContain('validation: `npx tsc --noEmit`');

    const reparsed = parseSpecKit({ spec: triplet.spec, plan: triplet.plan, tasks: triplet.tasks });
    expect(reparsed.tasks.map((t) => t.id)).toEqual(['scaffold', 'api']);
    expect(reparsed.tasks.find((t) => t.id === 'api')?.depends).toEqual(['scaffold']);
    expect(reparsed.tasks.find((t) => t.id === 'scaffold')?.validation).toBe('npx tsc --noEmit');
  });
});
