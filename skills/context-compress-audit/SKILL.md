---
name: context-compress-audit
description: Audit a repository, plugin setup, or agent session for raw Bash, Read, WebFetch, and MCP outputs that should be routed through context-compress instead. Use when asked to find context waste, raw tool output waste, missing plugin routing, or places where large command/file/web output still enters the agent context window.
---

# Context-Compress Audit

Find places where large raw output can still enter the agent context window.

## Procedure

1. Run `mcp__context-compress__stats` first if the tool is available.
2. Inspect setup surfaces that control routing:
   - `.codex-plugin/plugin.json`
   - `.claude-plugin/plugin.json`
   - `.mcp.json`
   - `hooks/`
   - `skills/`
   - README install instructions
3. Search for risky guidance or examples that encourage raw output:
   - `Bash` for tests, logs, `git log`, `git diff`, `curl`, `kubectl`, `docker`, `npm test`
   - `Read` for large logs, bundled files, snapshots, CSV/JSON dumps
   - `WebFetch` for documentation pages that should use `fetch_and_index`
   - Playwright snapshots without a file/index/search path
4. Report only actionable findings. Prefer one-line fixes that route work through:
   - `batch_execute` for several commands plus searches
   - `execute` for command/API output that must be analyzed first
   - `execute_file` for large local files
   - `fetch_and_index` plus `search` for web documentation

## Output

Use this format:

```md
## Context-Compress Audit

- [severity] file:line - raw-output risk. Replace with <tool/workflow>.
- [severity] file:line - missing install/routing coverage. Add <specific fix>.

Summary: <N> findings, estimated impact <low|medium|high>.
```

Severity:
- `high`: large output can enter context by default.
- `medium`: docs/examples teach a wasteful path.
- `low`: minor wording, missing cross-link, or optional setup gap.

If nothing meaningful is found, say `No raw-output waste found. Routing looks covered.`
