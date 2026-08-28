# Changelog

## 2026.8.1 (2026-08-28)

Three defects that only appear on a machine other than the one the release was built on.

### Fixed

- **`wrap` told every Linux user that a killed command had finished.** `spawn(shell: true)` means the watched process is /bin/sh, and the two platforms report a signalled child differently: macOS's sh re-raises the signal, so Node sees `signal`, while Linux's dash exits 128+N and Node sees `signal: null`. Measured with one script across three runtimes — darwin `{code: null, signal: "SIGKILL"}`, node:22-slim and node:24-slim both `{code: 137, signal: null}`. The capture-cap message reads only `signal`, so on Linux it printed "The command itself ran to completion" for a process that had been SIGKILLed — the exact claim the message exists to avoid. A shell's 128+N exit is now resolved back to the signal it stands for.
- **`uninstall` failed on any host without the `claude` CLI.** `unregisterMcpServer` returns "unavailable" when the CLI is not on PATH, and that was treated as a failure: uninstall exited 1 with nothing actually left behind, so CI, a container or a build image could never uninstall cleanly. It also blamed "settings.json could not be modified", which had been rewritten fine. That case is now a notice that still prints the manual command, and the summary names the step that actually failed.
- **A SQLite binding built by a different Node dumped a twelve-frame stack.** better-sqlite3 compiles its binding at install time against whichever Node ran `npm install`, and refuses to load under a different ABI — which is the normal outcome of having Homebrew's npm and nvm's node on the same PATH. Node's own message names two ABI numbers and nothing else: not the package, not the install path, not a command that would fix it. The CLI now names the running Node, the ABI the binding was built for, and the `npm rebuild --prefix <install root>` that repairs it. `doctor` needed the same fix separately — it catches the failure itself, so it had been printing Node's raw text under a `[FAIL]`.

### Internal

- The fuzzy-correction bound test was the flakiest in the suite. A warmup was not enough: it still measured 1,686ms on a busy machine against passing runs of 88-197ms on identical code. It now takes the fastest of three samples, since scheduling noise only adds time and the regression it guards measured 2,872ms in every run.

## 2026.8.0 (2026-08-24)

A hardening release. Thirty-five commits of review-driven defect work across the executor, the index, the network boundary and the CLI — plus four fixes for defects found by exercising the shipped tools rather than reading them.

### Fixed — the tools the hook redirects you to

- **Every `fetch_and_index` call to a host that requires a User-Agent failed with a bare `HTTP 403`.** Node sets no User-Agent, and the fetch snippet is pinned to the Node runtime because Bun ignores `createConnection`, so requests went out without the header. `api.github.com` rejects that outright. Bun's shim supplies a default, so the same URL succeeded through `execute()` and failed here — which also made the first attempt to reproduce it clear the header as the cause. Now sends `context-compress/<version>`.
- **A non-200 discarded the response body.** GitHub named the missing header in that 403's body and the snippet threw it away. Failures now carry a bounded prefix of the body: 2KB read, 300 characters reported, so an HTML error page cannot become the error message.
- **`fetch_and_index` refusing a private host was a dead end.** The refusal is correct — it is SSRF protection — but the Bash hook denies the download tools and names this tool first, so an intranet URL had nowhere to go. The message now names `execute()` as the route that works.
- **The PreToolUse hook read heredoc bodies as commands.** `isFetchCommand` treats every newline as a command boundary, so a line inside `python3 - <<'PY' … PY` that began with a tool name — after the environment-assignment skip, `VAR=0 <tool>` in a comment was enough — was denied. Writing a doc block, a commit message or a test fixture that merely mentioned one of these tools was blocked. Heredoc bodies are stripped before the scan. A heredoc fed to `bash` is no longer caught; the block is a redirection nudge and not a security boundary, and denying ordinary edits cost more. The inline-prefix evasion is still denied.
- **Every opt-out message named a variable but not where to set it**, and the obvious spelling — prefixing the command — is exactly what the environment-assignment skip removes before the flag is read. All three now name `~/.claude/settings.json` `"env"` and say the prefix does not work.
- **`doctor` reported "All checks passed" while the index was not persisted.** `persistDb` defaults to false, so the store opens at `:memory:`: `search()` reaches only what the current process indexed, and the cumulative stats file is never written. Both look like a healthy install until you restart. `doctor` now reports the store mode, and warns when a configured `dbDir` is not writable — `createServer` falls back to `:memory:` there, making a bad path indistinguishable from a good one.

### Fixed — compression, execution and the index

- The test-runner filter kept every per-file PASS badge on Jest and Vitest output, which write `` PASS  path`` with a leading space. Measured on 1,000 passing files plus one failure: 48,105 bytes in, 48,222 out — larger than the input. Now 298.
- `doctor` hashed its own bundled hook instead of the path `settings.json` points at, and reported a dead install as healthy.
- Fuzzy correction ran an unbounded Levenshtein on a near-miss: one search against a 20,000-character vocabulary word blocked the event loop for 2,872ms, and `search()` accepts 16 queries per call. Bounded on both sides: 25ms.
- A clock moved backwards fabricated regret, producing a persistent downgrade off aggressive mode.
- Execution-slot leak, zombie server, and silent state loss on shutdown.
- NAT64 and 6to4 SSRF paths that reached an embedded IPv4 destination the validator never inspected.
- Truncation spent its budget unevenly depending on line shape, and a failing run's diagnostic could be clamped off the end of a full budget.
- Untrusted content is labelled everywhere it enters context, and the index is bounded.

### Changed

- Hook opt-out messages name the settings file (see above).
- `doctor` gained an index-persistence check and exits with a warning rather than a clean pass when the store is in-memory.

### Notes

- `persistDb` still defaults to false. The store holds the full uncompressed output of every command and its default location is inside the project; persistence stays opt-in, and `doctor` now makes the opt-out visible instead of silent.

## 2026.7.1 (2026-07-29)

Modernization pass: align the hook and MCP surfaces with the current specs, and refresh the toolchain baseline.

> **Upgrade note:** the minimum runtime is now **Node 22**. Node 18 (EOL April 2025) and Node 20 (EOL April 2026) are both past end-of-life, and better-sqlite3 13 declares `engines: {node: ">=22"}` — on Node 20 it segfaults rather than failing cleanly. Stay on 2026.7.0 if you cannot move off Node 20.

### Fixed

- **PreToolUse deny reasons were silently dropped** — the WebFetch block emitted `hookSpecificOutput.reason`, but Claude Code reads `permissionDecisionReason`. Agents saw a bare denial with no redirect to `fetch_and_index`. Now uses the correct field, with a regression test asserting the legacy `decision`/`reason` pair is never emitted.
- **Duplicate PreToolUse hook registration** — `hooks/hooks.json` (the path plugin hosts auto-discover by convention) sat alongside the explicitly declared `hooks/claude-codex-hooks.json`, so a plugin install could spawn the hook twice per tool call and emit two conflicting decisions. The orphaned file is removed and a test keeps it gone.
- **`curl` / `wget` / inline-HTTP blocks** now return `permissionDecision: "deny"` with the redirect in the reason instead of rewriting the command into `echo "..."` — the agent gets the alternative immediately instead of paying for a shell round-trip.

### Changed

- **All 8 MCP tools migrated from the deprecated `server.tool()` overloads to `registerTool()`** — each now advertises a `title` and full `ToolAnnotations` (`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`). Code-executing tools (`execute`, `execute_file`, `batch_execute`) are pessimistically annotated as non-read-only, destructive, and open-world; `search` / `stats` / `discover` are read-only and closed-world.
- **No `outputSchema` on any tool, by design** — an output schema obliges the server to send `structuredContent` plus a serialized text duplicate, billing the same payload to the context window twice. `tests/integration/tool-manifest.test.ts` locks in both the annotation contract and the text-only response shape by driving the real server over an in-memory MCP transport.
- **`createServer()` now returns the `McpServer` instance and `shutdown`** alongside `start()`, so the server can be exercised over a test transport.
- **Node baseline raised to >= 22.** Node 18 and Node 20 are both end-of-life, and better-sqlite3 13 requires Node 22+; CI caught the mismatch as a SIGSEGV across every SQLite-touching test on the Node 20 leg. CI matrix is now 22/24; esbuild targets `node22`; `actions/checkout` and `actions/setup-node` bumped to v5.
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
