import { describe, it, expect } from 'vitest';
import { highlightYaml } from '../../../web/src/yaml-highlight.js';

describe('highlightYaml — pragmatic YAML tokeniser', () => {
  it('wraps a top-level key separately from its value', () => {
    const out = highlightYaml('name: foo');
    expect(out).toContain('<span class="t-key">name</span>');
    expect(out).toContain(':');
  });

  it('colours block-comment lines as comments', () => {
    const out = highlightYaml('# this is a comment');
    expect(out).toContain('<span class="t-com"># this is a comment</span>');
  });

  it('strips and re-colours trailing inline comments', () => {
    const out = highlightYaml('key: value  # trailing');
    expect(out).toContain('<span class="t-key">key</span>');
    expect(out).toContain('<span class="t-com">  # trailing</span>');
  });

  it('colours quoted strings without leaking into surrounding tokens', () => {
    const out = highlightYaml('greeting: "hello: world"');
    expect(out).toContain('<span class="t-key">greeting</span>');
    expect(out).toContain('<span class="t-str">&quot;hello: world&quot;</span>');
  });

  it('treats list dashes as tokens and colours the key after them', () => {
    const out = highlightYaml('  - id: scaffold');
    expect(out).toContain('<span class="t-tok">- </span>');
    expect(out).toContain('<span class="t-key">id</span>');
  });

  it('colours booleans and numbers', () => {
    const out = highlightYaml('enabled: true\nretries: 3');
    expect(out).toContain('<span class="t-kw">true</span>');
    expect(out).toContain('<span class="t-num">3</span>');
  });

  it('escapes user-supplied HTML so the output is safe to dangerouslySetInnerHTML', () => {
    const out = highlightYaml('value: "<script>x</script>"');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });
});
