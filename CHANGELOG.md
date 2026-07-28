# Changelog

## 2026.7.1 (2026-07-29)

Modernization pass: align the hook and MCP surfaces with the current specs, and refresh the toolchain baseline.

> **Upgrade note:** Node 18 is no longer supported (it reached end-of-life in April 2025). The minimum runtime is now Node 20.

### Fixed

- **PreToolUse deny reasons were silently dropped** — the WebFetch block emitted `hookSpecificOutput.reason`, but Claude Code reads `permissionDecisionReason`. Agents saw a bare denial with no redirect to `fetch_and_index`. Now uses the correct field, with a regression test asserting the legacy `decision`/`reason` pair is never emitted.
- **Duplicate PreToolUse hook registration** — `hooks/hooks.json` (the path plugin hosts auto-discover by convention) sat alongside the explicitly declared `hooks/claude-codex-hooks.json`, so a plugin install could spawn the hook twice per tool call and emit two conflicting decisions. The orphaned file is removed and a test keeps it gone.
- **`curl` / `wget` / inline-HTTP blocks** now return `permissionDecision: "deny"` with the redirect in the reason instead of rewriting the command into `echo "..."` — the agent gets the alternative immediately instead of paying for a shell round-trip.

### Changed

- **All 8 MCP tools migrated from the deprecated `server.tool()` overloads to `registerTool()`** — each now advertises a `title` and full `ToolAnnotations` (`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`). Code-executing tools (`execute`, `execute_file`, `batch_execute`) are pessimistically annotated as non-read-only, destructive, and open-world; `search` / `stats` / `discover` are read-only and closed-world.
- **No `outputSchema` on any tool, by design** — an output schema obliges the server to send `structuredContent` plus a serialized text duplicate, billing the same payload to the context window twice. `tests/integration/tool-manifest.test.ts` locks in both the annotation contract and the text-only response shape by driving the real server over an in-memory MCP transport.
- **`createServer()` now returns the `McpServer` instance and `shutdown`** alongside `start()`, so the server can be exercised over a test transport.
- **Node baseline raised to >= 20** (Node 18 reached end-of-life in April 2025). CI matrix is now 20/22/24; esbuild targets `node20`; `actions/checkout` and `actions/setup-node` bumped to v5.
- **Dependencies refreshed** — MCP SDK 1.27 → 1.30, better-sqlite3 12 → 13, Biome 1.9 → 2.5 (config migrated), TypeScript 5.7 → 5.9, esbuild 0.27 → 0.28, `@types/node` 20 → 24. `npm audit` now reports 0 vulnerabilities (the fixed advisories were all in the SDK's unused HTTP-transport dependency tree).
- **Dead code removed** that Biome 2 newly surfaced: unused imports in `executor.ts` / `uninstall.ts`, an unused parameter in `filterBuildOutput`, and three stale `biome-ignore` comments for a rule that no longer exists.

### Packaging

- **Hook bundle and its SHA-256 are now emitted by the same build step.** `npm run build` regenerated `hooks/pretooluse.mjs` but left `hooks/pretooluse.sha256` untouched, and `prepublishOnly` runs `build` — so a publish could ship a fresh bundle beside a stale checksum and make `doctor` report a bogus integrity failure to every user. `esbuild.config.mjs` now writes both, and `build:hooks` delegates to it via `--hooks-only` instead of duplicating the bundling command.

## 2026.7.0 (2026-07-06)

Smarter compression release — grounded in the 2026 agent-compression literature, whose core finding is that token-level extractive compression breaks agents by destroying action grammar. Every addition here operates on **whole structural units**, never partial tokens.

### Format-aware compression

- **New `src/format-filter.ts`** — when no command-specific filter matches, output is compressed by its *shape*: JSON is minified losslessly (balanced) or collapsed to a schema + sample (aggressive), NDJSON folds into per-shape summaries, and repetitive logs fold into `template ×count` via variable masking (Drain-style). Error/warning lines are always preserved verbatim and balanced-mode JSON stays parseable. Wired into both the Bash-hook path (`compressOutput`) and the `execute` shell path (`executor`). Typical wins: JSON −41% (still valid) to −96%, logs −98%.

### Intent-conditioned summaries

- **Query-ranked inlining** — `applyIntentFilter` now inlines the top query-ranked sections up to a byte budget (`CONTEXT_COMPRESS_INTENT_BUDGET_BYTES`, default 1800) instead of only listing section titles, cutting follow-up `search()` round-trips. Error lines are surfaced as a safety net. New config field `intentBudgetBytes` (per-level defaults).

### Self-tuning auto mode (ACON-style)

- **Compression-regret loop** (`src/util/regret.ts`) — when a command is compressed aggressively and then re-run fast (≤30s) repeatedly, `auto` records the regret and downgrades that command one step to preserve fidelity, with hysteresis so it doesn't oscillate. Downgrades only ever reduce compression, so a false positive costs tokens, never correctness. Surfaced in the `stats` self-tuning table.

### Quality-regression benchmark

- **New `src/bench/`** + `npm run bench:quality` — measures *survival of task-critical information*, not just token ratio, and a unit test fails if survival regresses below the per-case floor. Report at `docs/quality-regression-report.md`.

## 2026.6.0 (2026-06-24)

Plugin distribution and proof-of-effect release.

### Plugin support

- **Codex plugin manifest** — adds `.codex-plugin/plugin.json` plus `.mcp.json` so plugin-aware Codex installs can discover the MCP server and bundled skills.
- **Claude-compatible plugin metadata** — adds `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, and `hooks/claude-codex-hooks.json` for plugin-based PreToolUse routing.
- **Packaged plugin assets** — npm package now includes `.codex-plugin/`, `.claude-plugin/`, `.mcp.json`, `hooks/`, `skills/`, and `docs/`.

### Skills and docs

- **New `context-compress:audit` skill** — audits repos or sessions for raw Bash/Read/WebFetch paths that should route through `batch_execute`, `execute`, `execute_file`, or `fetch_and_index`.
- **Agentic benchmark plan** — adds `docs/agentic-benchmark.md` with baseline isolation, MCP-only vs hook arms, success scoring, context-byte metrics, and reporting limits.
- **README positioning update** — first-screen message now emphasizes the core product claim: large tool output stays searchable instead of entering the conversation.

### Validation

- **Plugin manifest tests** — verifies Codex/Claude manifests, MCP companion config, package file coverage, discoverable docs/skills, and actual PreToolUse rewrite behavior.
- **Proof-of-effect hook test** — confirms `git log -10` is rewritten to `context-compress wrap --mode balanced`, proving plugin routing changes real Bash behavior.

## 2026.5.0 (2026-05-10)

Major feature release: 4 compression modes (incl. LLM-judged auto), RTK-style standalone CLI, RTK-beating compression numbers, and a thoroughly modularized codebase.

### Compression modes

- **Three explicit modes** — `conservative` (ANSI strip only), `balanced` (default; strips noise, preserves metadata), `aggressive` (drops metadata for max compression). Pass `--mode` or set `CONTEXT_COMPRESS_MODE`.
- **`auto` mode** — an LLM picks `conservative`/`balanced`/`aggressive` per command output. Backends in priority: Anthropic API → `claude -p` CLI → heuristic fallback. Decisions cached at `~/.context-compress/auto-cache.json` with 24h TTL.
- **Aggressive command filters** for `git log`, `git diff`, `git status`, `ls -la*`, `find`, `grep`/`rg`, `npm ls`, `df`, `du`, `ps aux`.
- **Balanced now compresses meaningfully** — previously did nothing on `git log`, `ls`, `find`. Now drops universal noise (`./..`, `total N`), truncates `git log` bodies past 3 lines with `[+N omitted]`, summarizes `find`/`ls -R` past 20 entries. Default mode goes from 45% to 75% reduction without dropping any metadata.

### Standalone CLI (RTK-compatible)

- **`context-compress wrap "<cmd>"`** — runs a shell command and pipes its stdout through the compression pipeline. Drop-in replacement for RTK-style usage.
- **`context-compress filter [--cmd '<orig>']`** — stdin → compressed → stdout pipe filter.
- **`--stream` mode** for `wrap` — line-by-line filtered output for `tail -f`, `cargo watch`, builds with progressive output. Stream-safe pipeline only.
- **Single-binary lite CLI** — `npm run build:bin` cross-compiles via Bun for `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`. ~61MB static binary, no Node required.

### Setup

- **`context-compress setup --auto`** (alias `init --auto`) — one-line install: writes `~/.claude/settings.json`, registers MCP server, installs PreToolUse hook, enables transparent Bash compression. Idempotent. Preserves unrelated user settings.
- **PreToolUse hook auto-wrap** — set `CONTEXT_COMPRESS_FILTER_BASH=1` and the hook routes output-heavy `Bash` calls through `context-compress wrap` automatically. Conservative allowlist (git, npm, cargo, test runners, find/grep/ls -R, docker, kubectl, terraform, helm, make/gradle/bazel, ps/df/du, go/rustc tests).
- **Mode forwarding** — hook propagates `CONTEXT_COMPRESS_MODE` to wrapped commands via `--mode`.

### MCP server

- **8th tool: `discover`** — lists indexed sources, top searchable terms, optimization suggestions for the agent.
- **`isError: true`** added to all error responses for MCP protocol compliance.
- **`server.ts` modularized**: 845 lines → 132. Tool handlers extracted to `src/tools/*.ts` (one file per tool + shared `ToolContext`). Utilities to `src/util/*.ts` (`path`, `version`, `label`, `fetch-code`, `intent-filter`, `stream-compress`, `auto-mode`).

### Security & performance

- **IPv6 hex-mapped SSRF gap closed** — blocks `::ffff:7f00:1`, `::ffff:c0a8:101`, etc. (the dotted-decimal form was already handled).
- **`getDistinctiveTerms` cached** per source — was re-scanning up to 500 chunks on every call. Cache invalidates on `index()`.
- **`buildFetchCode` IPv6 fix** — properly brackets IPv6 hostnames before assigning to `URL.hostname` (the setter doesn't auto-bracket; raw `2001:db8::1` parsed the first `:` as a port).
- **ANSI stripping order fix** — was running *after* command filters, which prevented test/git output detection when output had color codes. Now runs first.

### Benchmarks

- **`scripts/benchmark.ts`** — synthetic, reproducible compression numbers (96.5% on 10 representative outputs).
- **`scripts/benchmark-real.ts`** — runs actual commands in this repo and measures (68.7% byte-weighted overall; 99.3% on `npm test` alone).
- **`scripts/benchmark-vs-rtk.ts`** — head-to-head with RTK 0.39.0 supporting all 4 modes plus `--auto` LLM mode and `--json` output.

  | | RTK | conservative | balanced | aggressive | auto |
  |---|---:|---:|---:|---:|---:|
  | Overall | 82.5% | 6.0% | 75.4% | **93.0%** | 77.9% |

  Aggressive beats RTK by 10.5pp on the same commands.

### CI / DX

- **CI restored** — `.github/workflows/ci.yml` runs typecheck + lint + tests + build on Node 20 and 22.
- **Tests: 119 → 213** (+94). 18 unit test files plus 3 integration files.
- **README modernized** — featured-numbers hero, RTK comparison table, updated project structure, four-mode comparison, "Reproducing the benchmarks" section.

### Bug fixes

- ANSI/filter ordering bug in `executor.ts` (color codes hid `PASS`/`FAIL`/`✓`/`✗` markers from command filters).
- Removed dead `bytesSaved` field from per-command `CumulativeStats` (always serialized as 0).
- Cached global `ANSI_RE_G` regex (was creating `new RegExp` on every `stripAnsi` call).
- Fixed `filterPs` regex `/\b%CPU\b/` that never matched (`%` is not a word char; `\b` requires word/non-word transition). Switched to plain `header.includes("%CPU")`.
- Fixed test data typo `ℸ` (DALETH SYMBOL, U+2138) → `ℹ` (INFORMATION SOURCE, U+2139, what `node:test` actually emits).
- Deduplicated `getVersion` between `cli/doctor.ts` and `server.ts` into shared `src/util/version.ts`.
- Fixed `git diff --stat` aggressive mode dropping all output (the `+`/`-` filter doesn't apply to stat-format).

---

## 1.0.0 (2026-03-02)

First release — TypeScript rewrite of context-mode with security and architecture improvements.

### Security
- **Credential passthrough is now opt-in** (`passthroughEnvVars` defaults to `[]`)
- **Removed self-modifying hook code** (no more `fs.writeFileSync` to settings.json)
- **Fixed shell injection in Rust compilation** (`execFileSync` with array args)
- **Removed upgrade command** (no more `git clone` from arbitrary URLs)
- **Removed silent npm install** on startup

### Architecture
- **LanguagePlugin system** — add new languages by creating one file (was 4 files)
- **Lazy trigram FTS5** — trigram table created only when Porter search returns 0 results (~50% write reduction)
- **Bounded vocabulary** — 10,000 word cap prevents unbounded growth
- **Version from package.json** — no more hardcoded version mismatch

### Performance
- **Parallel runtime detection** — `Promise.all` async detection (~40ms vs ~250ms sequential)
- **Parallel batch_execute** — `Promise.allSettled` for concurrent command execution
- **Glob/WebSearch excluded from hooks** — no more Node.js spawn for passthrough

### Developer Experience
- **Configuration system** — ENV vars / `.context-compress.json` / defaults
- **Debug mode** — `CONTEXT_COMPRESS_DEBUG=1` surfaces all catch block errors
- **Curl blocking is configurable** — `CONTEXT_COMPRESS_BLOCK_CURL=0` to disable
- **Clean uninstall** — `context-compress uninstall` removes hooks, MCP registration, stale DBs
- **Honest naming** — "SubprocessExecutor" instead of "sandbox"
