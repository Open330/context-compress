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
Install context-compress — an MCP server that compresses tool output for Claude Code.
Raw data stays in sandboxed subprocesses, only concise summaries enter your context window.
Saves ~99% of tokens on large outputs while keeping everything searchable via FTS5.

npm install -g context-compress
claude mcp add context-compress -- node $(which context-compress)
context-compress doctor

More info: https://github.com/Open330/context-compress
```

<div><img src="https://quickstart-for-agents.vercel.app/api/footer.svg?theme=claude-code&project=context-compress" width="100%" /></div>

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

## Compression Modes

context-compress offers four compression modes that trade fidelity for compactness. Pass `--mode` to the CLI, set `CONTEXT_COMPRESS_MODE` in your environment, or let the default (`balanced`) just work.

| Mode | Strategy | Use when |
|:--|:--|:--|
| `conservative` | ANSI strip only — preserves every byte of meaningful content | You need full fidelity, debugging output, archival logs |
| `balanced` *(default)* | Strip noise (progress bars, deprecation warnings, hint lines) — keep metadata (commit bodies, file dates, full test failures) | Day-to-day agent work where context might be re-read |
| `aggressive` | Drop metadata too — git log → oneline, ls -la → name+size, find lower threshold, grep grouped | Maximum token savings; agent will rarely need the dropped detail |
| `auto` | An LLM (Anthropic API or `claude -p`) picks one of the above per command, based on a 500-byte sample of the output. Decisions cached for 24h | You don't want to think about it — let the model judge per output |

```bash
# CLI flag (per-call override)
context-compress wrap --mode aggressive "git log -50"

# Env var (set once for the session)
export CONTEXT_COMPRESS_MODE=aggressive
```

The PreToolUse hook also forwards `CONTEXT_COMPRESS_MODE` automatically when wrapping Bash commands, so agents transparently get whatever mode you've configured.

### Head-to-head with [RTK](https://github.com/rtk-ai/rtk)

Reproduce locally:

```bash
git clone https://github.com/rtk-ai/rtk /tmp/rtk && (cd /tmp/rtk && cargo build --release)
RTK_BIN=/tmp/rtk/target/release/rtk tsx scripts/benchmark-vs-rtk.ts
```

Result on this repository (RTK 0.39.0 vs context-compress 2026.3.22):

| Command | Raw | RTK | CC `conservative` | CC `balanced` | CC `aggressive` | CC `auto` (LLM) |
|:--|--:|--:|--:|--:|--:|--:|
| `git status` | 577 B | 241 B (58%) | 577 B (0%) | 375 B (35%) | **187 B (68%)** | balanced (35%) |
| `git log -10` (full) | 21.3 KB | 3.2 KB (85%) | 21.3 KB (0%) | 4.6 KB (79%) | **947 B (96%)** | balanced (79%) |
| `git log -50` (full) | 36.9 KB | 10.1 KB (73%) | 36.9 KB (0%) | 12.3 KB (67%) | **3.2 KB (91%)** | balanced (67%) |
| `git diff --stat` | 425 B | 424 B (0%) | 425 B (0%) | 425 B (0%) | 425 B (0%) | balanced (0%) |
| `ls src/` | 149 B | 229 B (-54%) | 149 B (0%) | 149 B (0%) | 149 B (0%) | conservative (0%) |
| `ls -laR src/` | 3.8 KB | **229 B (94%)** | 3.8 KB (0%) | 3.1 KB (19%) | 877 B (78%) | aggressive (78%) |
| `find *.ts` | 1.0 KB | 589 B (44%) | 1.0 KB (0%) | **183 B (83%)** | **183 B (83%)** | aggressive (83%) |
| `npm test` | 21.8 KB | 114 B (99%) | 16.7 KB (24%) | **120 B (99%)** | **120 B (99%)** | balanced (99%) |
| **Overall** (byte-weighted) | **85.9 KB** | 15.0 KB (82.5%) | 80.8 KB (6.0%) | 21.2 KB (75.4%) | **6.0 KB (93.0%)** | 19.0 KB (77.9%) |

Three things to take from this table:

1. **`balanced` is competitive on its own.** The default mode hits ~75% reduction without dropping any metadata — agents get full commit headers, file perms/dates, and complete test failure detail. Only 7pp behind RTK while making a different fidelity trade-off.
2. **`aggressive` decisively wins on raw compression** — 93.0%, beating RTK by 10.5pp. Pick this when you want maximum token savings and the agent will rarely re-read the dropped detail.
3. **`auto` lets the model pick.** Per-command LLM judgment landed at 77.9% overall — between balanced and aggressive. The interesting result is *what* it picked: `balanced` for git/test outputs (where commit bodies and failure detail matter), `aggressive` for `ls -laR` and `find` (where the question is "what's there?", not "show me everything"), `conservative` for tiny outputs where compression is pointless.

Aggressive mode covers a wider command surface than the table above hints — it also handles `df` (drops pseudo-filesystems), `du` (top-N by size), `ps aux` (PID/%CPU/%MEM/CMD only, drops kernel threads), `npm ls` (strips tree-drawing chars + `deduped`/`extraneous` markers), and `grep`/`rg` (groups by file, truncates long lines).

What balanced now does (over conservative):
- `ls -l*` drops `total N`, `.`/`..` entries (universal noise) but keeps perms/dates
- `git log` keeps headers + first 3 body lines per commit, replacing the rest with `[+N lines omitted]`
- `find` / `ls -R` summarizes per-directory once output exceeds 20 entries
- Generic dedup/progress/group runs at 5KB instead of 10KB

> RTK has a single fixed compression strategy — comparable to context-compress `aggressive`. context-compress lets the agent choose: reach for `aggressive` when the question is "what changed", `balanced` when the question is "explain why".

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

# Compression mode: conservative | balanced (default) | aggressive | auto
CONTEXT_COMPRESS_MODE=balanced

# Auto mode prefers the Anthropic API when this is set (faster than `claude -p` fallback)
ANTHROPIC_API_KEY=sk-ant-...

# RTK-style transparent Bash wrapping (default: off)
CONTEXT_COMPRESS_FILTER_BASH=1

# Override path to the context-compress binary used by the hook
CONTEXT_COMPRESS_BIN=/usr/local/bin/context-compress
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
context-compress                            # Start MCP server (stdio)
context-compress setup                      # Detect runtimes, show install instructions
context-compress setup --auto               # One-line: write ~/.claude/settings.json
context-compress init --auto                # Alias for setup --auto
context-compress doctor                     # Diagnose: runtimes, hooks, FTS5, version
context-compress uninstall                  # Clean removal: hooks, MCP reg, stale DBs

# RTK-style transparent compression — use anywhere, agent doesn't need MCP
context-compress wrap "npm test"                       # default = balanced
context-compress wrap --mode aggressive "git log -50"  # max compression
context-compress wrap --stream "tail -f /var/log/app.log"  # line-by-line for long-running cmds
context-compress filter --cmd "git push" < captured.log    # pipe filter
```

### Bash auto-wrap (transparent mode)

Set `CONTEXT_COMPRESS_FILTER_BASH=1` and the PreToolUse hook will route output-heavy `Bash` calls through `context-compress wrap` automatically — the agent doesn't need to call `execute()` to benefit. Combine with `CONTEXT_COMPRESS_MODE=aggressive` for maximum compression.

### Doctor Output Example

```
  context-compress doctor

  [PASS] Performance: FAST — Bun detected
  [PASS] Language coverage: 7/11 (64%)
  [PASS] Server test: OK
  [PASS] PreToolUse hook configured
  [PASS] FTS5 / better-sqlite3 works

  Version: v2026.3.3
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
npm run test:unit     # Unit tests
npm run test          # All tests (unit + integration)
npm run build         # Compile + bundle
```

---

## License

[MIT](LICENSE) — Based on [context-mode](https://github.com/mksglu/claude-context-mode) by Mert Koseoğlu.
