/**
 * Tiny YAML highlighter. Pragmatic, regex-based — won't handle every
 * pathological edge case (multi-line block scalars with embedded quotes
 * etc.) but covers the shape of every yaao execution plan we'll
 * realistically see, in <80 lines, with zero deps.
 *
 * Used by the PlanEdit and (raw) Config editors to render a highlighted
 * overlay behind a transparent textarea, so the user sees colour without
 * losing native textarea ergonomics (selection, undo, find-on-page).
 */

const ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPE[c] ?? c);
}

/**
 * Highlight a YAML string. Returns an HTML string of `<span>`-wrapped
 * tokens safe to drop into `dangerouslySetInnerHTML` (we escape user
 * input first).
 *
 * Order matters: comments are pulled out first so a `#` inside a string
 * doesn't get re-coloured; strings next so a `:` inside one doesn't
 * look like a key separator; then everything else.
 */
export function highlightYaml(code: string): string {
  // Tokenise line by line — most YAML rules are line-local, and doing
  // it this way means a malformed line doesn't corrupt the whole file's
  // rendering.
  return code
    .split('\n')
    .map((rawLine) => {
      // Quick wins for whole-line shapes.
      if (/^\s*#/.test(rawLine)) {
        return `<span class="t-com">${escapeHtml(rawLine)}</span>`;
      }
      if (/^(---|\.\.\.)\s*$/.test(rawLine)) {
        return `<span class="t-tok">${escapeHtml(rawLine)}</span>`;
      }

      // Pull out any trailing comment so we can colour it separately
      // without it leaking into earlier replaces.
      let main = rawLine;
      let trailingComment = '';
      const commentMatch = /^(.*?)(\s+#.*)$/.exec(rawLine);
      if (commentMatch && !/^['"][^'"]*$/.test(commentMatch[1] ?? '')) {
        main = commentMatch[1] ?? '';
        trailingComment = commentMatch[2] ?? '';
      }

      let html = escapeHtml(main);
      // Quoted strings (single + double). Run before key/number/etc. so
      // a `:` inside a quoted value doesn't look like a key separator.
      html = html.replace(/(&quot;)([^&]|&(?!quot;))*?\1/g, (m) => `<span class="t-str">${m}</span>`);
      html = html.replace(/(&#39;)([^&]|&(?!#39;))*?\1/g, (m) => `<span class="t-str">${m}</span>`);
      // Keys: leading whitespace + dash-and-space prefix optional, then
      // an identifier followed by `:` (and either a space or EOL).
      html = html.replace(
        /^(\s*(?:-\s+)?)([A-Za-z_$][\w$-]*)(:)(?=\s|$)/,
        '$1<span class="t-key">$2</span>$3',
      );
      // Block-scalar indicators (|, >) at end of a value.
      html = html.replace(/:\s(\||&gt;)(\s*$)/, ': <span class="t-tok">$1</span>$2');
      // Booleans / null (case-insensitive in YAML 1.2, but stick to lower
      // for less false-positive risk inside identifiers).
      html = html.replace(/(\s|^|:\s)(true|false|null|yes|no)\b/g, '$1<span class="t-kw">$2</span>');
      // Numbers (integers and decimals; not inside identifiers).
      html = html.replace(/(\s|:\s|^)(-?\d+(?:\.\d+)?)\b/g, '$1<span class="t-num">$2</span>');
      // Anchors / refs (&foo, *foo).
      html = html.replace(/(\s|^)([&*][A-Za-z_][\w-]*)/g, '$1<span class="t-ref">$2</span>');
      // List markers (the leading `- `).
      html = html.replace(/^(\s*)(-\s)/, '$1<span class="t-tok">$2</span>');

      return trailingComment
        ? `${html}<span class="t-com">${escapeHtml(trailingComment)}</span>`
        : html;
    })
    .join('\n');
}
