/**
 * Canonical system-prompt directive injected into every task when ctx-sys is enabled
 * and not overridden. Advisory only — yaao does not fail tasks for skipping the call.
 */
export const CTX_SYS_DIRECTIVE = `This project uses ctx-sys for codebase context. BEFORE writing or modifying code,
you SHOULD call the \`context_query\` MCP tool with a query relevant to the task. Examples:
  - "How is authentication wired up?"
  - "Where is the database schema defined?"
You may call it multiple times. The tool returns curated context from this codebase.

If the task is trivial (a typo fix, a one-line bump) you may skip the query.`;
