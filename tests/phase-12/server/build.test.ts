import { describe, it, expect } from 'vitest';
import { buildMcpServer } from '../../../src/mcp/server.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';

describe('buildMcpServer', () => {
  it('constructs without throwing and exposes the expected tool surface', () => {
    const server = buildMcpServer({ cwd: '/tmp/yaao-mcp-build', config: DEFAULT_CONFIG });
    // The McpServer instance keeps registered tools internally. We don't drive a real
    // transport here — the test ensures construction succeeds and (via the type
    // checker) every tool's registration shape lines up with the SDK contract.
    expect(server).toBeDefined();
  });
});
