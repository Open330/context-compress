<div align="center">

# context-compress

**Keep your context window lean. Let the sandbox do the heavy lifting.**

[![CI](https://github.com/Open330/context-compress/actions/workflows/ci.yml/badge.svg)](https://github.com/Open330/context-compress/actions)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.json)

A context-aware **MCP server** for [Claude Code](https://claude.ai/claude-code) that compresses tool output by processing it in isolated subprocesses. Raw data stays in the sandbox — only concise summaries enter your context window.

[Quickstart for Agents](#quickstart-for-agents) · [Getting Started](#getting-started) · [How It Works](#how-it-works) · [Token Reduction](#token-reduction) · [Configuration](#configuration) · [CLI](#cli) · [Changelog](CHANGELOG.md)

</div>

---

## Quickstart for Agents

<div><img src="https://quickstart-for-agents.vercel.app/api/header.svg?theme=claude-code&title=context-compress&lang=Agents&mascot=thinking" width="100%" /></div>

```
npm install -g context-compress && claude mcp add context-compress -- node $(which context-compress)
```

<div><img src="https://quickstart-for-agents.vercel.app/api/footer.svg?theme=claude-code&project=context-compress" width="100%" /></div>

MCP server that compresses tool output for Claude Code — raw data stays in sandboxed subprocesses, only concise summaries enter your context window.

---

## Why?

Every byte of tool output that enters your Claude Code context window **reduces quality and speed**.
A single `git log` or `npm test` can dump 50KB+ into context — that's ~12,000 tokens gone.

**context-compress** intercepts these tools, processes output in a sandbox, and returns only what matters:

```
Before:  git log --oneline -100  →  8.2KB into context
After:   execute("git log ...")  →  0.3KB summary + full data searchable in FTS5
```

> Based on [context-mode](https://github.com/mksglu/claude-context-mode) by Mert Koseoğlu — rewritten in TypeScript with security hardening, architectural improvements, and better DX.

---

## Getting Started

### Install

```bash
npm install -g context-compress
```

### Add to Claude Code

```bash
claude mcp add context-compress -- node $(which context-compress)
```

Or add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "context-compress": {
      "command": "node",
      "args": ["/path/to/context-compress/dist/index.js"]
    }
  }
}
```

### Verify

```bash
context-compress doctor
```

---

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│                     Claude Code                          │
│                                                          │
│  "Run tests"  ──→  PreToolUse Hook intercepts            │
│                          │                               │
│                          ▼                               │
│               ┌──────────────────┐                       │
│               │  context-compress │                      │
│               │   MCP Server      │                      │
│               └────────┬─────────┘                       │
│                        │                                 │
│            ┌───────────┼───────────┐                     │
│            ▼           ▼           ▼                     │
│     ┌──────────┐ ┌──────────┐ ┌──────────┐              │
│     │ Executor │ │  Store   │ │  Stats   │              │
│     │ (11 lang)│ │  (FTS5)  │ │ Tracker  │              │
│     └──────────┘ └──────────┘ └──────────┘              │
│            │           │                                 │
│            ▼           ▼                                 │
│     Raw output    Indexed &     Only summary             │
│     stays here    searchable    enters context           │
└─────────────────────────────────────────────────────────┘
```

### 7 MCP Tools

| Tool | What it does |
|:-----|:-------------|
| **`execute`** | Run code in 11 languages. Only stdout enters context. |
| **`execute_file`** | Process a file via `FILE_CONTENT` variable — file never enters context. |
| **`index`** | Chunk markdown/text into FTS5 knowledge base for search. |
| **`search`** | BM25 search with Porter stemming → trigram → fuzzy fallback. |
| **`fetch_and_index`** | Fetch URL → HTML-to-markdown → auto-index. Preview only in context. |
| **`batch_execute`** | Run N commands + search in ONE call. Replaces 30+ tool calls. |
| **`stats`** | Real-time session statistics: bytes saved, tokens avoided, savings ratio. |

### Supported Languages

`javascript` · `typescript` · `python` · `shell` · `ruby` · `go` · `rust` · `php` · `perl` · `r` · `elixir`

> Bun auto-detected for 3-5x faster JS/TS execution.

---

## Token Reduction

context-compress achieves **99.2% token reduction** across a typical 12-operation coding session.

| Operation | Before | After | Reduction |
|:--|--:|--:|--:|
| Read bundled file (776KB) | 194,076 tok | 105 tok | 99.9% |
| Playwright snapshot (56KB) | 14,000 tok | 75 tok | 99.5% |
| Read CSV/JSON data (100KB) | 25,000 tok | 125 tok | 99.5% |
| Read source file (21KB) | 5,250 tok | 88 tok | 98.3% |
| npm install log (15KB) | 3,750 tok | 50 tok | 98.7% |
| curl API response (12KB) | 3,000 tok | 88 tok | 97.1% |
| npm test (42 tests) | 935 tok | 45 tok | 95.2% |
| batch_execute (5 cmds) | 6,250 tok | 375 tok | 94.0% |
| fetch_and_index (45KB page) | 11,250 tok | 750 tok | 93.3% |
| grep (small output) | 361 tok | 361 tok | 0% |
| **Session Total** | **267,121 tok** | **2,223 tok** | **99.2%** |

Without context-compress, 12 operations consume **133% of the 200K context window** — overflowing it entirely. With context-compress, the same operations use **1.1%**, leaving 98.9% free for actual conversation.

> Data isn't deleted — it's indexed in FTS5 and searchable on demand. Small outputs (<5KB) pass through uncompressed.

**[Read the full Token Reduction Report](docs/token-reduction-report.md)** — includes cost analysis, architecture deep-dive, and FAQ on context loss trade-offs.

---

## What Changed from context-mode

| | context-mode | context-compress |
|:--|:------------|:-----------------|
| **Credentials** | 20+ auth env vars passed by default | Opt-in only (`passthroughEnvVars: []`) |
| **Hook writes** | Self-modifies `settings.json` | Zero filesystem writes |
| **Rust compile** | Shell string → injection risk | `execFileSync` with array args |
| **Upgrade** | `git clone` arbitrary code | Removed entirely |
| **FTS5 indexing** | Always dual-table (Porter + trigram) | Lazy trigram — 50% fewer writes |
| **Runtime detect** | Sequential `execSync` ~250ms | Parallel `Promise.all` ~40ms |
| **batch_execute** | Sequential commands | `Promise.allSettled` parallel |
| **Config** | None | ENV + file + defaults |
| **Errors** | 23 silent catch blocks | `CONTEXT_COMPRESS_DEBUG=1` logs all |
| **Uninstall** | None | `context-compress uninstall` |

---

## Configuration

Loaded in order: **ENV vars** → **`.context-compress.json`** → **defaults**

### Environment Variables

```bash
# Enable debug logging (stderr)
CONTEXT_COMPRESS_DEBUG=1

# Pass specific env vars to subprocesses (default: none)
CONTEXT_COMPRESS_PASSTHROUGH_ENV=GH_TOKEN,AWS_PROFILE

# Disable curl/wget blocking
CONTEXT_COMPRESS_BLOCK_CURL=0

# Disable WebFetch blocking
CONTEXT_COMPRESS_BLOCK_WEBFETCH=0

# Disable Read/Grep nudges
CONTEXT_COMPRESS_NUDGE_READ=0
CONTEXT_COMPRESS_NUDGE_GREP=0
```

### Config File

Create `.context-compress.json` in your project root or home directory:

```json
{
  "passthroughEnvVars": ["GH_TOKEN", "AWS_PROFILE", "KUBECONFIG"],
  "blockCurl": true,
  "blockWebFetch": true,
  "debug": false
}
```

---

## CLI

```bash
context-compress            # Start MCP server (stdio)
context-compress setup      # Detect runtimes, show install instructions
context-compress doctor     # Diagnose: runtimes, hooks, FTS5, version
context-compress uninstall  # Clean removal: hooks, MCP reg, stale DBs
```

### Doctor Output Example

```
  context-compress doctor

  [PASS] Performance: FAST — Bun detected
  [PASS] Language coverage: 7/11 (64%)
  [PASS] Server test: OK
  [PASS] PreToolUse hook configured
  [PASS] FTS5 / better-sqlite3 works

  Version: v1.0.0
  All checks passed.
```

---

## Project Structure

```
context-compress/
├── src/
│   ├── index.ts              # Entry point
│   ├── server.ts             # MCP server (7 tools)
│   ├── executor.ts           # SubprocessExecutor
│   ├── store.ts              # ContentStore (FTS5)
│   ├── config.ts             # Config system
│   ├── logger.ts             # Debug logger
│   ├── snippet.ts            # FTS5 snippet extraction
│   ├── stats.ts              # Session tracker
│   ├── types.ts              # Shared types
│   ├── runtime/
│   │   ├── plugin.ts         # LanguagePlugin interface
│   │   ├── index.ts          # Registry + parallel detection
│   │   └── languages/        # 11 language plugins
│   ├── hooks/
│   │   └── pretooluse.ts     # PreToolUse hook (no self-mod)
│   └── cli/
│       ├── index.ts          # CLI entry
│       ├── setup.ts          # Interactive setup
│       ├── doctor.ts         # Diagnostics
│       └── uninstall.ts      # Clean removal
├── tests/
│   ├── unit/                 # 7 unit test files
│   └── integration/          # 3 integration test files
├── hooks/
│   └── hooks.json            # Hook matcher config
├── skills/                   # Slash command definitions
└── dist/                     # Compiled output
```

---

## Security

| Threat | Mitigation |
|:-------|:-----------|
| Credential leakage | `passthroughEnvVars` defaults to `[]` — zero env vars passed unless opted in |
| Shell injection (Rust) | `execFileSync` with array arguments — no string interpolation |
| Hook self-modification | No `fs.writeFileSync` in hooks — zero filesystem side effects |
| Arbitrary code execution | No `upgrade` command — no `git clone` or `npm install` at runtime |
| Silent failures | Debug mode surfaces all catch block errors to stderr |

---

## Contributing

```bash
git clone https://github.com/Open330/context-compress
cd context-compress
npm install
npm run typecheck     # Type checking
npm run lint          # Biome linting
npm run test:unit     # 36 unit tests
npm run test          # All tests (unit + integration)
npm run build         # Compile + bundle
```

---

## License

[MIT](LICENSE) — Based on [context-mode](https://github.com/mksglu/claude-context-mode) by Mert Koseoğlu.
