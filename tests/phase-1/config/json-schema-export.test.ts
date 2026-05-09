import { describe, it, expect } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ConfigSchema } from '../../../src/config/schema.js';

describe('JSON Schema artifact', () => {
  it('zod-to-json-schema produces a top-level YaaoConfig definition', () => {
    const schema = zodToJsonSchema(ConfigSchema, { name: 'YaaoConfig' });
    const root = schema as { $ref?: string; definitions?: Record<string, unknown> };
    expect(root.$ref).toBe('#/definitions/YaaoConfig');
    expect(root.definitions?.['YaaoConfig']).toBeDefined();
    const def = root.definitions?.['YaaoConfig'] as { properties: Record<string, unknown> };
    expect(def.properties['version']).toBeDefined();
    expect(def.properties['defaults']).toBeDefined();
  });
});
