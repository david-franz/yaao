import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { yaaoConvertTool, type ToolContext } from '../../../src/mcp/tools.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

const MD = `# Hello

> Demo

## Tasks

| id | title | depends |
|----|-------|---------|
| a  | A     |         |
| b  | B     | a       |

## a — A
prose

## b — B
prose
`;

describe('yaao_convert MCP tool', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('writes a schema-valid execution plan', async () => {
    project = createTmpProject();
    project.write('plan.md', MD);
    const ctx: ToolContext = { cwd: project.path, config: DEFAULT_CONFIG };
    const r = await yaaoConvertTool({ input: 'plan.md' }, ctx);
    expect(r.structuredContent['tasks']).toBe(2);
    const outPath = r.structuredContent['outPath'] as string;
    expect(existsSync(outPath)).toBe(true);
  });
});
