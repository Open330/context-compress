<div align="center">

# context-compress

**Stop drowning your AI agent in shell output.**
Large tool output stays searchable in index-backed flows — not stuffed into the context window.
Use it through an MCP server, a drop-in CLI, agent plugins, or all three.

[![CI](https://github.com/Open330/context-compress/actions/workflows/ci.yml/badge.svg)](https://github.com/Open330/context-compress/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/context-compress?color=cb3837&logo=npm)](https://www.npmjs.com/package/context-compress)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A522-brightgreen?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![Tests](https://img.shields.io/badge/tests-unit%20%2B%20integration-success)](#contributing)

[Quickstart](#quickstart) · [Plugin Support](#plugin-support) · [Compression Modes](#compression-modes) · [vs RTK](#head-to-head-with-rtk) · [How It Works](#how-it-works) · [Configuration](#configuration) · [CLI](#cli) · [Changelog](CHANGELOG.md)

</div>

<table align="center">
<tr>
<td align="center" width="25%">

**93%**
<br>token reduction
<br><sub>aggressive mode</sub>

</td>
<td align="center" width="25%">

**Searchable**
<br>indexed data retained
<br><sub>FTS5 + BM25</sub>

</td>
<td align="center" width="25%">

**4 modes**
<br>incl. LLM-judged
<br><sub>auto • aggressive • balanced • conservative</sub>

</td>
<td align="center" width="25%">

**Plugins**
<br>Codex + Claude
<br><sub>MCP • hooks • skills</sub>

</td>
</tr>
</table>

---

## Quickstart

```bash
# 1. Install
npm install -g context-compress

# 2. One-line setup — registers the MCP server, installs the hook,
#    enables transparent Bash compression
context-compress setup --auto

# 3. (optional) Pick a mode for the session
export CONTEXT_COMPRESS_MODE=balanced   # or: aggressive, conservative, auto
```

That's it. Restart Claude Code and shell output is now compressed before it enters context.

> **Prefer no MCP at all?** `context-compress wrap "<cmd>"` compresses any shell command's output — drop-in for [RTK](https://github.com/rtk-ai/rtk). See [CLI](#cli).

<details>
<summary><b>Quickstart for AI agents</b> — paste this prompt and your agent will install it</summary>

<div><img src="https://quickstart-for-agents.vercel.app/api/header.svg?theme=claude-code&title=context-compress&lang=Agents&mascot=thinking" width="100%" /></div>

```
Install context-compress — an MCP server that compresses tool output for Claude Code.
Only the printed or filtered response enters your context window.
For searchable retention, use index, fetch_and_index, batch_execute, or intent on a large execute call.

npm install -g context-compress
context-compress setup --auto
context-compress doctor

More info: https://github.com/Open330/context-compress
```

<div><img src="https://quickstart-for-agents.vercel.app/api/footer.svg?theme=claude-code&project=context-compress" width="100%" /></div>

</details>

---

## Why?

Every byte of tool output that enters your Claude Code context window **reduces quality and speed**.
A single `git log` or `npm test` can dump 50KB+ into context — that's ~12,000 tokens gone.

**context-compress** intercepts these tools, processes output in a sandbox, and returns only what matters:

```
Before:  git log --oneline -100                    →  8.2KB into context
After:   execute(..., intent: "recent changes")   →  0.3KB summary + bounded pre-filter data searchable in FTS5
```

It works in two modes that compose freely:

- **MCP server** — registers as a Claude Code MCP server with 8 tools (`execute`, `search`, `batch_execute`, `fetch_and_index`, `index`, `execute_file`, `stats`, `discover`). Agents call them directly when output would be large.
- **Standalone CLI** — `context-compress wrap "<cmd>"` runs any shell command and pipes the output through the same compression pipeline. Drop-in for [RTK](https://github.com/rtk-ai/rtk) and friends. The PreToolUse hook can route `Bash` calls through it transparently when `CONTEXT_COMPRESS_FILTER_BASH=1`. This is response-only compression: detail omitted by a filter is not indexed or available to `search`.

> Based on [context-mode](https://github.com/mksglu/claude-context-mode) by Mert Koseoğlu — rewritten in TypeScript with security hardening, architectural improvements, and better DX.

---

## Getting Started

### Install

```bash
npm install -g context-compress
```

### Plugin Support

context-compress now ships plugin metadata for agent hosts:

| Host | Files | What they enable |
|:--|:--|:--|
| **Codex** | `.codex-plugin/plugin.json`, `.mcp.json`, `skills/` | MCP server registration plus skills in plugin-aware Codex flows. |
| **Claude Code** | `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `hooks/claude-codex-hooks.json` | PreToolUse routing, skills, and MCP config from a plugin install. |
| **Manual / fallback** | `context-compress setup --auto` | Writes `~/.claude/settings.json` directly when plugin installation is not available. |

The plugin manifests are designed for built package/archive installs where `dist/`, `hooks/`, and `skills/` are present together. For a raw source checkout, run `npm install && npm run build` before testing the plugin locally, or use the global npm setup above.

### One-line setup

```bash
context-compress setup --auto
```

Writes `~/.claude/settings.json` for you: registers the MCP server, installs the PreToolUse hook, enables transparent Bash compression. Idempotent — re-running with the same paths makes zero changes. Preserves any unrelated user settings.

### Manual setup

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

The Store path applies only when a tool indexes content: `index`, `fetch_and_index`,
`batch_execute`, and large `execute` calls with `intent`. Ordinary `execute` calls
without `intent` and CLI `wrap` return compressed responses only; anything omitted
from those responses is not searchable later.

### 8 MCP Tools

| Tool | What it does |
|:-----|:-------------|
| **`execute`** | Run code in 11 languages. With `intent`, large executor-capped pre-filter output is indexed; without it, omitted response detail is not searchable. |
| **`execute_file`** | Process a file via `FILE_CONTENT` variable — file never enters context. |
| **`index`** | Chunk markdown/text into FTS5 knowledge base for search. |
| **`search`** | BM25 search with Porter stemming → trigram → fuzzy fallback. |
| **`fetch_and_index`** | Fetch URL → HTML-to-markdown → auto-index. Preview only in context. |
| **`batch_execute`** | Run N commands + search in ONE call. Replaces 30+ tool calls. |
| **`stats`** | Session + cumulative statistics: bytes saved, tokens avoided, savings ratio. |
| **`discover`** | Lists indexed sources, top searchable terms, and suggests next actions. |

### Supported Languages

`javascript` · `typescript` · `python` · `shell` · `ruby` · `go` · `rust` · `php` · `perl` · `r` · `elixir`

> Bun auto-detected for 3-5x faster JS/TS execution.

### MCP protocol surface

Every tool is registered through `registerTool()` and advertises a human-readable `title` plus behavior annotations, so clients can gate them without guessing from the name:

| Tool | `readOnlyHint` | `destructiveHint` | `openWorldHint` |
|:--|:--|:--|:--|
| `execute`, `execute_file`, `batch_execute` | false | true | true |
| `fetch_and_index` | false | false | true |
| `index` | false | false | false |
| `search`, `stats`, `discover` | true | false | false |

**No tool declares an `outputSchema`** — that is deliberate. A tool with an output schema must return `structuredContent` *and* a serialized text copy for backwards compatibility, so the same payload is billed to the context window twice. For a server whose entire purpose is to shrink that window, text-only responses are the correct trade. `tests/integration/tool-manifest.test.ts` enforces both halves of this contract.

### PreToolUse hook contract

The hook speaks the current `hookSpecificOutput` shape — `permissionDecision` paired with `permissionDecisionReason`, `updatedInput` to rewrite arguments, `additionalContext` to append guidance. The deprecated top-level `decision` / `reason` fields are never emitted. Blocked `curl`/`wget`/inline-HTTP calls are **denied with the redirect in the reason** rather than rewritten into an `echo`, which saves a shell round-trip and puts the alternative directly in front of the agent.

---

## Compression Modes

context-compress offers four compression modes that trade fidelity for compactness. Pass `--mode` to the CLI, set `CONTEXT_COMPRESS_MODE` in your environment, or let the default (`balanced`) just work.

| Mode | Strategy | Use when |
|:--|:--|:--|
| `conservative` | ANSI strip only — preserves every byte of meaningful content | You need full fidelity, debugging output, archival logs |
| `balanced` *(default)* | Strip noise (progress bars, deprecation warnings, hint lines) — keep metadata (commit bodies, file dates, full test failures) | Day-to-day agent work where context might be re-read |
| `aggressive` | Drop metadata too — git log → oneline, ls -la → name+size, find lower threshold, grep grouped | Maximum token savings; agent will rarely need the dropped detail |
| `auto` | An LLM (Anthropic API or `claude -p`) picks one of the above per command, based on a 500-byte sample of the output. Decisions cached for 24h | You don't want to think about it — let the model judge per output |

> **Privacy note for `auto` mode:** the command line and a 500-byte output sample are sent to the Anthropic API (or the local `claude` CLI) — it is the only context-compress feature that sends your data anywhere. Common secret shapes (API keys, tokens, `password=...`, private keys, URL credentials) are scrubbed from both before sending, best-effort. If either may contain credentials, prefer a fixed mode.

```bash
# CLI flag (per-call override)
context-compress wrap --mode aggressive "git log -50"

# Env var (set once for the session)
export CONTEXT_COMPRESS_MODE=aggressive
```

The PreToolUse hook also forwards `CONTEXT_COMPRESS_MODE` automatically when wrapping Bash commands, so agents transparently get whatever mode you've configured.

### Beyond mode selection

Three capabilities layer on top of the modes above. All are grounded in the 2026 agent-compression literature, whose central finding is that *token-level* extractive compression (LLMLingua-2, Selective Context) breaks agents by destroying action grammar — so context-compress only ever operates on **whole structural units**, never partial tokens.

- **Format-aware compression** — when no command-specific filter matches, output is compressed by its *shape*. Pretty-printed JSON is minified losslessly (balanced) or collapsed to a schema + sample (aggressive); NDJSON folds into per-shape summaries; repetitive logs fold into `template ×count` via variable masking (Drain-style). Error/warning lines are always kept verbatim, and balanced-mode JSON stays parseable. Typical wins: JSON −41% (still valid) to −96%, logs −98%.
- **Intent-conditioned summaries** — pass `intent` to `execute` and large output is indexed from the executor-capped copy captured before lossy command, format, deduplication, and response-truncation filters. The top query-ranked sections are then inlined up to a byte budget (`CONTEXT_COMPRESS_INTENT_BUDGET_BYTES`, default 1800) instead of only listing section titles — fewer follow-up `search()` round-trips. Error lines are surfaced as a safety net. Without `intent`, `execute` only returns its compressed response and does not retain omitted detail.
- **Self-tuning `auto` mode (ACON-style)** — when a command is compressed aggressively and then re-run fast (≤30s) repeatedly, `auto` records the "regret" and downgrades that command one step to preserve fidelity. Downgrades only ever *reduce* compression, so a false positive costs tokens, never correctness. See the self-tuning table in `stats`.

Verify fidelity yourself with the quality-regression benchmark, which measures **survival of task-critical information**, not just token ratio:

```bash
npm run bench:quality   # report at docs/quality-regression-report.md
```

### Head-to-head with [RTK](https://github.com/rtk-ai/rtk)

Reproduce locally:

```bash
git clone https://github.com/rtk-ai/rtk /tmp/rtk && (cd /tmp/rtk && cargo build --release)
RTK_BIN=/tmp/rtk/target/release/rtk tsx scripts/benchmark-vs-rtk.ts
```

Result on this repository (RTK 0.39.0 vs context-compress 2026.5.0):

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

> The `npm test` row was measured on `node --test` output. Jest and Vitest
> indent their `PASS`/`FAIL` badges by one space; that shape was not compressed
> at all until v2026.7.2 — it came back marginally larger than the input.
| **Overall** (byte-weighted) | **85.9 KB** | 15.0 KB (82.5%) | 80.8 KB (6.0%) | 21.2 KB (75.4%) | **6.0 KB (93.0%)** | 19.0 KB (77.9%) |

Three things to take from this table:

1. **`balanced` is competitive on its own.** The default mode hits ~75% reduction without dropping any metadata — agents get full commit headers, file perms/dates, and complete test failure detail. Only 7pp behind RTK while making a different fidelity trade-off.
2. **`aggressive` decisively wins on raw compression** — 93.0%, beating RTK by 10.5pp. Pick this when you want maximum token savings and the agent will rarely re-read the dropped detail.
3. **`auto` lets the model pick.** Per-command LLM judgment landed at 77.9% overall — between balanced and aggressive. The interesting result is *what* it picked: `balanced` for git/test outputs (where commit bodies and failure detail matter), `aggressive` for `ls -laR` and `find` (where the question is "what's there?", not "show me everything"), `conservative` for tiny outputs where compression is pointless.

Aggressive mode covers a wider command surface than the table above hints — it also handles `df` (drops pseudo-filesystems), `du` (top-N by size), `ps aux` (PID/%CPU/%MEM/CMD only, drops kernel threads), `npm ls` (strips tree-drawing chars + `deduped`/`extraneous` markers), and `grep`/`rg` (groups by file, truncates long lines).

What balanced now does (over conservative):
- `ls -l*` drops `total N`, `.`/`..` entries (universal noise) but keeps perms/dates
- `git log` keeps headers + first 3 body lines per commit, replacing the rest with `[+N lines omitted]`
- `find` / `ls -R` keeps the first 20 entries verbatim, then summarizes the remainder per-directory
- `kubectl get` (>30 rows) folds healthy rows into per-namespace/status counts but keeps non-healthy rows verbatim; output with no `STATUS` column (`get svc`, `get events`) keeps the first 20 rows verbatim instead, since there is nothing to fold on
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

> Searchable retention applies to `index`, `fetch_and_index`, `batch_execute`, and large `execute` calls with `intent`. Ordinary `execute` and `wrap` calls only compress the response, so filtered-out detail is not available to `search`. Small intent-filter inputs (≤5KB by default) pass through without indexing.

**[Read the full Token Reduction Report](docs/token-reduction-report.md)** — includes cost analysis, architecture deep-dive, and FAQ on context loss trade-offs.

**[Read the Agentic Benchmark Plan](docs/agentic-benchmark.md)** — defines the fair on/off benchmark for real Claude Code sessions, including baseline isolation, task success checks, and reporting limits.

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

The MCP server loads its settings in this order: **ENV vars** → project
**`.context-compress.json`** → home **`.context-compress.json`** → **defaults**.
The standalone PreToolUse hook does not load that file; hook controls are
environment-only.

### Server Environment Variables

Every server setting has an environment override. All of them are optional.

| Variable | Default | What it does |
|:--|:--|:--|
| `CONTEXT_COMPRESS_DEBUG` | `0` | Log to stderr, including otherwise-silent catch blocks |
| `CONTEXT_COMPRESS_PASSTHROUGH_ENV` | *(none)* | Comma-separated env vars copied into subprocesses |
| `CONTEXT_COMPRESS_LEVEL` | `normal` | `normal` \| `compact` \| `ultra` — scales every budget below |
| `CONTEXT_COMPRESS_MAX_OUTPUT_BYTES` | `102400` | Max bytes returned to the caller per execution |
| `CONTEXT_COMPRESS_HARD_CAP_BYTES` | `16777216` | Capture ceiling; the process is killed past it |
| `CONTEXT_COMPRESS_SEARCH_MAX_BYTES` | `40960` | Byte budget for a whole `search` response |
| `CONTEXT_COMPRESS_BATCH_MAX_BYTES` | `81920` | Byte budget for a whole `batch_execute` response |
| `CONTEXT_COMPRESS_SEARCH_LIMIT` | `3` | Results per query |
| `CONTEXT_COMPRESS_SEARCH_WINDOW_MS` | `60000` | Throttling window |
| `CONTEXT_COMPRESS_SEARCH_REDUCE_AFTER` | `3` | Calls in the window before results are reduced to 1 |
| `CONTEXT_COMPRESS_SEARCH_BLOCK_AFTER` | `8` | Calls in the window before `search` is refused |
| `CONTEXT_COMPRESS_INTENT_SEARCH_THRESHOLD` | `5000` | Output size above which `intent` triggers indexing |
| `CONTEXT_COMPRESS_INTENT_BUDGET_BYTES` | `1800` | Byte budget for content inlined into an intent summary |
| `CONTEXT_COMPRESS_PERSIST_DB` | `0` | Keep the knowledge base across restarts — see below |
| `CONTEXT_COMPRESS_DB_DIR` | *(none)* | Where the persistent database lives; implies persistence |
| `CONTEXT_COMPRESS_MODE` | `balanced` | Default compression mode for `filter`/`wrap` |

### The knowledge base is ephemeral by default

`persistDb` defaults to **false**: the database lives in a private temporary
directory and is deleted when the MCP server exits. Indexed content is
searchable for the life of that server process, not across restarts.

To keep it, set `CONTEXT_COMPRESS_PERSIST_DB=1` (or `dbDir`), which stores it
under `.context-compress/` in your project. A persistent store retains the most
recent `maxIndexedSources` (default 500) and prunes older ones, so it does not
grow without bound.

### Config File

Create `.context-compress.json` in your project root or home directory:

Your home file `~/.context-compress.json` accepts every key:

```json
{
  "passthroughEnvVars": ["GH_TOKEN", "AWS_PROFILE", "KUBECONFIG"],
  "maxOutputBytes": 102400,
  "debug": false
}
```

A project file accepts everything except the keys below:

```json
{
  "mode": "aggressive",
  "debug": false
}
```

**A project file may not set security-relevant keys.** These ten are honored
only from your home file or the environment:

| Key | Why it is restricted |
|---|---|
| `passthroughEnvVars` | Names which of your env vars reach every subprocess — including a `postinstall` script. |
| `persistDb`, `dbDir` | Decide where the database is written on your disk. |
| `hardCapBytes`, `maxOutputBytes` | The memory guard. `maxOutputBytes` raises `hardCapBytes` to match it, so leaving it project-settable hands the guard back. |
| `searchWindowMs`, `searchBlockAfter`, `searchReduceAfter` | A wide window with a low threshold switches `search` off for the rest of the session. |
| `maxIndexedSources` | `0` disables pruning, so a persistent store grows without bound. |
| `compressionLevel` | Rewrites `maxOutputBytes`, `searchMaxBytes`, `batchMaxBytes` and `searchLimit`, so it reaches the budgets above indirectly. |

A project file travels with the repository, so an untrusted clone could
otherwise name your credentials in `passthroughEnvVars` and have them copied
into every subprocess. Those keys are ignored with a warning on stderr when they
appear in a project file; every other key layers over your home settings
normally.

Hook-only keys such as `blockCurl`, `blockWebFetch`, `nudgeOnRead`, and
`nudgeOnGrep` are not part of the JSON-file schema.

### PreToolUse Hook Environment Variables

The hook reads these variables directly from its process environment:

```bash
# Disable curl/wget or WebFetch blocking
CONTEXT_COMPRESS_BLOCK_CURL=0
CONTEXT_COMPRESS_BLOCK_WEBFETCH=0

# Disable Read/Grep nudges
CONTEXT_COMPRESS_NUDGE_READ=0
CONTEXT_COMPRESS_NUDGE_GREP=0

# RTK-style transparent Bash wrapping (default: off)
CONTEXT_COMPRESS_FILTER_BASH=1

# Compression mode forwarded to wrap: conservative | balanced | aggressive | auto
CONTEXT_COMPRESS_MODE=balanced

# Override the context-compress binary used by the hook
CONTEXT_COMPRESS_BIN=/usr/local/bin/context-compress

# Stop appending MCP routing guidance to Task/Agent subagent prompts
CONTEXT_COMPRESS_ROUTE_SUBAGENTS=0
```

When the hook rewrites a subagent prompt it now tells the parent agent what it
appended, so a capped or redirected response is never mistaken for the
subagent's own judgement. Agents whose tool set does not include the MCP tools
are left alone.

`CONTEXT_COMPRESS_MODE` also configures direct CLI `wrap`/`filter` calls. Auto
mode prefers the Anthropic API when `ANTHROPIC_API_KEY` is set in your shell or
secret manager (faster than the `claude -p` fallback).

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

`wrap` and `filter` do not write to the FTS5 knowledge base. They reduce the
response only, so content removed by their filters cannot be recovered with
`search` unless you separately index the original content.

### Bash auto-wrap (transparent mode)

Set `CONTEXT_COMPRESS_FILTER_BASH=1` and the PreToolUse hook will route output-heavy `Bash` calls through `context-compress wrap` automatically — the agent doesn't need to call `execute()` to benefit. Combine with `CONTEXT_COMPRESS_MODE=aggressive` for maximum compression. Never-ending commands (`top`, `kubectl logs -f`, `docker stats`, dev servers, watch modes) are never wrapped — buffered wrapping would hang them. That includes package scripts: the hook reads `package.json`, so `npm test` is left alone when it maps to a watcher like a bare `vitest`.

### Doctor Output Example

```
  context-compress doctor

  [PASS] Performance: FAST — Bun detected
  [PASS] Language coverage: 7/11 (64%)
  [PASS] Server test: OK
  [PASS] PreToolUse hook configured
  [PASS] Hook integrity: SHA-256 verified (a3f1c8d2e4...)
  [PASS] FTS5 / better-sqlite3 works
  [WARN] Index is in-memory — search() cannot reach anything indexed
         before this process started, and cumulative stats are never
         written. Compression still works; retrieval does not persist.
         Enable: CONTEXT_COMPRESS_PERSIST_DB=1 (or set dbDir).

  Version: v2026.8.0
  1 warning(s) — see above. No critical issues.
```

That warning is the default: `persistDb` is opt-in, so a stock install compresses
but does not keep its index between runs. Set `CONTEXT_COMPRESS_PERSIST_DB=1` and
the line becomes `[PASS] Index persisted at …/store.db`.

---

## Project Structure

```
context-compress/
├── src/
│   ├── index.ts              # MCP server entry
│   ├── server.ts             # Wires deps, registers tools (177 lines, was 845)
│   ├── executor.ts           # SubprocessExecutor + ANSI/dedup pipeline
│   ├── filters.ts            # Command-aware filters (git, npm, ls, find, ps, ...)
│   ├── store.ts              # ContentStore (FTS5 + BM25 + Porter + trigram + Levenshtein)
│   ├── network.ts            # SSRF / DNS rebinding protection
│   ├── stats.ts              # Session + cumulative session tracker
│   ├── config.ts             # Config: ENV → file → defaults
│   ├── snippet.ts            # FTS5 snippet extraction
│   ├── logger.ts             # Debug logger
│   ├── types.ts              # Shared types
│   ├── utils.ts              # detectInjectionPatterns, limitConcurrency, formatBytes
│   ├── runtime/
│   │   ├── index.ts          # Parallel runtime detection + registry
│   │   ├── plugin.ts         # LanguagePlugin interface
│   │   └── languages/        # 11 language plugins (js, ts, py, sh, rb, go, rs, php, pl, r, ex)
│   ├── tools/                # MCP tool handlers (one file per tool)
│   │   ├── context.ts        # Shared ToolContext interface
│   │   ├── execute.ts
│   │   ├── execute-file.ts
│   │   ├── index-content.ts
│   │   ├── search.ts
│   │   ├── fetch-and-index.ts
│   │   ├── batch-execute.ts
│   │   ├── stats.ts
│   │   └── discover.ts
│   ├── util/                 # Pure utilities (extracted from server.ts for testability)
│   │   ├── path.ts           # isWithinProject (path-traversal safe)
│   │   ├── fetch-code.ts     # buildFetchCode (HTML→md sandbox script)
│   │   ├── intent-filter.ts  # createIntentFilter factory
│   │   ├── label.ts          # compactLabel (compression levels)
│   │   ├── version.ts        # getVersion (deduped across CLI commands)
│   │   ├── stream-compress.ts# Line-by-line StreamCompressor for `wrap --stream`
│   │   └── auto-mode.ts      # LLM-driven mode selection (Anthropic API + claude CLI)
│   ├── hooks/
│   │   └── pretooluse.ts     # PreToolUse hook (curl/Bash/Read/Grep/WebFetch/Task)
│   └── cli/
│       ├── index.ts          # CLI dispatcher
│       ├── lite.ts           # Single-binary entry (filter+wrap only, no MCP)
│       ├── filter.ts         # `filter` (stdin) + `wrap` (spawn) commands
│       ├── setup.ts          # `setup` / `init` — interactive + --auto
│       ├── doctor.ts         # `doctor` — diagnostics
│       └── uninstall.ts      # `uninstall` — clean removal
├── tests/
│   ├── unit/                 # 41 unit test files
│   └── integration/          # 4 integration test files
├── scripts/
│   ├── benchmark.ts          # Synthetic compression benchmark
│   ├── benchmark-real.ts     # Real-command benchmark on this repo
│   └── benchmark-vs-rtk.ts   # Head-to-head vs RTK with --auto support
├── hooks/                    # Pre-built hook bundle (shipped in npm package)
├── skills/                   # Slash command definitions
├── docs/                     # Token reduction report + architecture docs
└── dist/                     # Compiled output (build artifact)
```

> `server.ts` is now thin (177 lines) — it constructs deps, builds a `ToolContext`, registers the 8 tool modules, and wires shutdown. All tool handlers live under `src/tools/`, all reusable helpers under `src/util/`.

---

## Security

| Threat | Mitigation |
|:-------|:-----------|
| Credential leakage | `passthroughEnvVars` defaults to `[]` — zero env vars passed to subprocesses unless opted in |
| Shell injection | `execFileSync` with array arguments throughout — no string interpolation into shells |
| SSRF / private-IP fetch | `fetch_and_index` blocks RFC1918, link-local, loopback, IPv4-mapped IPv6 (incl. hex form `::ffff:HHHH:HHHH`), CGNAT |
| DNS rebinding (TOCTOU) | `resolveAndValidate`, then the socket is opened directly against the validated IP via `createConnection` while the URL keeps its hostname (so TLS SNI and cert validation still apply). Runs on the Node runtime only — Bun's `node:http` shim ignores connection pinning, so the fetch tool refuses to run there rather than proceed unpinned |
| Redirect-based SSRF | Redirects are reported, never followed: the target has not been through `resolveAndValidate` |
| Path traversal | `isWithinProject` uses `realpathSync` to defeat symlink escapes; falls back to string-prefix for not-yet-existing paths |
| Hook self-modification | Hooks are read-only — no `fs.writeFileSync` in `src/hooks/`. Hook integrity SHA-256 verified by `doctor` |
| Arbitrary code execution | No `upgrade` command — no `git clone` or `npm install` at runtime. Setup writes only to `~/.claude/settings.json` |
| Silent failures | `CONTEXT_COMPRESS_DEBUG=1` surfaces all catch-block errors to stderr |
| Subprocess sandboxing | OS-level sandboxing not enforced (by design for the MCP trust model). See [SECURITY.md](SECURITY.md) for the full trust model. |

---

## Contributing

```bash
git clone https://github.com/Open330/context-compress
cd context-compress
npm install

npm run typecheck        # Strict TS
npm run lint             # Biome
npm test                 # All tests (unit + integration)
npm run test:unit        # Unit tests only

npm run build            # Compile + bundle MCP server + CLI
npm run build:hooks      # Bundle the PreToolUse hook (with SHA-256)
npm run build:bin        # Cross-compile single binaries via Bun (4 targets)
```

### Reproducing the benchmarks

```bash
# Synthetic — fast, reproducible, includes RTK-style commands
tsx scripts/benchmark.ts

# Real-world — runs actual commands in your repo
tsx scripts/benchmark-real.ts            # full
tsx scripts/benchmark-real.ts --quick    # skip npm test

# Head-to-head with RTK (build it first)
git clone https://github.com/rtk-ai/rtk /tmp/rtk
(cd /tmp/rtk && cargo build --release)

RTK_BIN=/tmp/rtk/target/release/rtk tsx scripts/benchmark-vs-rtk.ts
RTK_BIN=... tsx scripts/benchmark-vs-rtk.ts --auto    # also run LLM-judged auto mode
RTK_BIN=... tsx scripts/benchmark-vs-rtk.ts --json    # machine-readable
```

For real agent sessions, use [docs/agentic-benchmark.md](docs/agentic-benchmark.md) to compare baseline, MCP-only, hook-balanced, and hook-aggressive arms with isolated settings.

---

## License

[MIT](LICENSE) — Based on [context-mode](https://github.com/mksglu/claude-context-mode) by Mert Koseoğlu.

> **Inspired by [RTK](https://github.com/rtk-ai/rtk)** for the command-aware filtering tactic. context-compress builds on the same idea with multi-mode trade-offs, an LLM-judged `auto` mode, MCP integration, sandbox execution, and a searchable knowledge base.
