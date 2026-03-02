# context-compress

Context-aware MCP server that compresses tool output for Claude Code. Keeps raw data in sandboxed subprocesses — only summaries enter your context window.

Based on [context-mode](https://github.com/mksglu/claude-context-mode), rewritten in TypeScript with security hardening, architectural improvements, and developer experience enhancements.

## Features

- **11 language runtimes** — JavaScript, TypeScript, Python, Shell, Ruby, Go, Rust, PHP, Perl, R, Elixir
- **FTS5 knowledge base** — Index content, search with BM25 ranking + fuzzy correction
- **Smart truncation** — 60% head + 40% tail when output exceeds limits
- **Network tracking** — JS/TS fetch calls tracked as sandbox-kept bytes
- **PreToolUse hooks** — Auto-redirect data-fetching tools through sandbox
- **Subagent routing** — Hooks inject context-compress usage into subagent prompts

## What's Different from context-mode

| Area | context-mode | context-compress |
|------|-------------|-----------------|
| Credential passthrough | All auth env vars by default | Opt-in via `passthroughEnvVars` (default: none) |
| Hook self-modification | Writes to settings.json, installed_plugins.json | No filesystem writes from hooks |
| Rust compilation | Shell string interpolation | `execFileSync` with array args (no injection) |
| Upgrade command | `git clone` from GitHub | Removed (use npm) |
| Trigram FTS5 | Always dual-indexed | Lazy — only created when Porter returns 0 hits |
| Runtime detection | Sequential `execSync` (~250ms) | Parallel `Promise.all` (~40ms) |
| batch_execute | Sequential execution | `Promise.allSettled` parallel execution |
| Configuration | None | ENV vars + `.context-compress.json` + defaults |
| Debug mode | Silent catch blocks | `CONTEXT_COMPRESS_DEBUG=1` logs all errors |
| Uninstall | None | `context-compress uninstall` |

## Installation

```bash
npm install -g context-compress

# Add to Claude Code
claude mcp add context-compress -- node $(which context-compress)
```

Or add to `.mcp.json`:

```json
{
  "mcpServers": {
    "context-compress": {
      "command": "node",
      "args": ["path/to/context-compress/dist/index.js"]
    }
  }
}
```

## Configuration

Configuration is loaded from (in priority order):
1. Environment variables (`CONTEXT_COMPRESS_*`)
2. Config file (`.context-compress.json` in project root or home directory)
3. Defaults

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXT_COMPRESS_DEBUG` | `0` | Enable debug logging to stderr |
| `CONTEXT_COMPRESS_PASSTHROUGH_ENV` | _(empty)_ | Comma-separated env vars to pass to subprocesses |
| `CONTEXT_COMPRESS_BLOCK_CURL` | `1` | Block curl/wget in Bash hook (`0` to disable) |
| `CONTEXT_COMPRESS_BLOCK_WEBFETCH` | `1` | Block WebFetch tool (`0` to disable) |
| `CONTEXT_COMPRESS_NUDGE_READ` | `1` | Show execute_file tip on Read (`0` to disable) |
| `CONTEXT_COMPRESS_NUDGE_GREP` | `1` | Show execute tip on Grep (`0` to disable) |

### Config File Example

```json
{
  "passthroughEnvVars": ["GH_TOKEN", "AWS_PROFILE"],
  "blockCurl": true,
  "debug": false
}
```

## CLI Commands

```bash
context-compress          # Start MCP server (stdio)
context-compress setup    # Interactive setup — detect runtimes, show install instructions
context-compress doctor   # Diagnose issues — runtimes, hooks, FTS5, version
context-compress uninstall # Clean removal — hooks, MCP registration, stale DBs
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `execute` | Run code in sandboxed subprocess (11 languages) |
| `execute_file` | Process file in sandbox via FILE_CONTENT variable |
| `index` | Index markdown/text into FTS5 knowledge base |
| `search` | Query indexed content with BM25 + fuzzy fallback |
| `fetch_and_index` | Fetch URL, convert HTML to markdown, index |
| `batch_execute` | Run multiple commands + search in one call |
| `stats` | Session statistics and context savings |

## Troubleshooting

### Debug mode
```bash
CONTEXT_COMPRESS_DEBUG=1 node dist/index.js
```

### FTS5 issues
```bash
context-compress doctor
```

### Disable curl blocking
```bash
CONTEXT_COMPRESS_BLOCK_CURL=0
```

## License

MIT
