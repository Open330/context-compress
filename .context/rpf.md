# RPF Pointer

> Living source of truth for iterative review, planning, work, and feedback.
> RPF re-reads this document throughout every cycle. Multiple agents may edit
> it concurrently: take the write lock, re-read, merge, then write.

## Goal

- Improve context-compress performance, user experience, and overall production quality through an evidence-driven RPF run of up to 128 cycles, stopping early only at verified convergence.
- Treat UI/UX as the user-facing CLI, MCP tool, plugin, setup, diagnostics, error-message, documentation, and perceived-performance experience because this repository has no graphical UI assets.

## Policies and constraints

- Follow repository instructions and preserve user-authored intent and pre-existing dirty-worktree changes.
- Prefer the smallest design that fixes verified issues; do not add unrequested features, abstractions, operational dependencies, or broad refactors.
- Surface assumptions and material uncertainty before implementation.
- Require executable tests or checks for every completed change and run configured repository gates after integration.
- Do not weaken completion criteria to claim convergence.
- Content marked `RPF-LOCKED` requires explicit user authorization to change.

## Completion criteria

- [ ] Verified performance defects in exercised hot paths are fixed with targeted regression tests or reproducible measurement evidence.
- [ ] Verified user-experience defects in the CLI, MCP tools, plugins, setup/doctor flows, errors, or docs are fixed with targeted regression tests.
- [ ] Verified correctness, security, reliability, maintainability, testing, API/DX, and documentation findings are resolved or explicitly refuted.
- [ ] No actionable feedback or unresolved goal gaps remain.
- [ ] No pending, active, integrated, or blocked work remains.
- [ ] `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` all pass on the integrated commit.

<!-- rpf:managed:start -->
## RPF state

- Status: running
- Pointer revision: 16
- Last writer: rpf-codex-20260810T061531Z-9935
- Total cycles: 2
- Cycles allocated: 2
- Last completed cycle: 1
- Review input revision: 4
- User instruction epoch: 2
- State manifest revision: 0
- Work ID high-watermark: 37
- Gap ID high-watermark: 6
- Next action: Integrate the eight active worker scopes, then claim newly ready dependents RPF-025, RPF-029, RPF-032, RPF-035, and RPF-037 without an unrelated barrier.

This document is the self-sufficient hot control-plane index and the only
manifest/commit point. Authored intent, live coordination, every nonterminal
scheduling or convergence input, and compact anti-duplication and completion-
evidence indexes remain inline. Detailed or cold managed records may stay
inline indefinitely or move to immutable shards; sharding is never required by
a byte limit.

## State shard manifest

`STATE_DIR` is derived from this pointer's resolved path. Paths below are
POSIX-style paths relative to that directory. A shard is committed state only
when this manifest references its exact digest. `Covers` is a comma-separated,
bytewise-sorted list of exact root keys: an ordinary table row's `ID` or a
durable index `Record ID`. It is a validation field, not a discovery query.
`Purpose` is human-readable and never drives loading.
Every `Detail shard` or `Shard ID` cell contains exactly one manifest
`Shard ID`, or `-`; it never contains a path.

| Shard ID | Kind | Rev | SHA-256 | Path | Covers | Purpose |
|---|---|---:|---|---|---|---|

## Active runs

| Run ID | Tool | Cycle | Phase | Lease expires (UTC) | Target ref | Integration path | Claimed work | Claimed paths |
|---|---|---|---|---|---|---|---|---|
| rpf-codex-20260810T061531Z-9935 | codex | 2 | work | 2026-08-10T09:34:45Z | fix/fetch-pinning-and-destructive-filters | /tmp/context-compress-rpf-codex-20260810T061531Z-9935 | RPF-017,RPF-024,RPF-026,RPF-027,RPF-028,RPF-030,RPF-031,RPF-034,RPF-036 | src/cli/filter.ts,src/cli/setup.ts,src/filters.ts,src/hooks/pretooluse.ts,src/network.ts,src/runtime/languages/go.ts,src/tools/batch-execute.ts,src/tools/execute-file.ts,src/tools/execute.ts,tests/integration/batch.test.ts,tests/unit/cli-filter.test.ts,tests/unit/cli-index.test.ts,tests/unit/executor.test.ts,tests/unit/filter-modes.test.ts,tests/unit/network.test.ts,tests/unit/pretooluse.test.ts,tests/unit/runtime.test.ts,tests/unit/setup-auto.test.ts,tests/unit/execute-tools.test.ts |

## Current understanding

- `context-compress` is a TypeScript/Node 22+ MCP server and CLI whose core promise is to keep large tool output searchable while reducing context-window use; evidence: `package.json`, `README.md`.
- The user-facing surface is CLI/MCP/plugin-based rather than graphical; UI/UX review therefore covers command ergonomics, tool contracts, setup/doctor, messages, docs, and perceived latency; evidence: `src/cli/`, `src/tools/`, `.codex-plugin/`, `.claude-plugin/`, `README.md`.
- The repository is dirty with pre-existing untracked `.codex/` and `.context/` artifacts, so implementation must use an isolated integration worktree and preserve those files; evidence: `git status --short --branch` at invocation start.
- CI defines typecheck, lint, unit/integration tests, and build on Node 22 and 24; the local configured gates are the matching package scripts; evidence: `.github/workflows/ci.yml`, `package.json`.
- The publishable npm package and `prepublishOnly` script constitute a detected deployment target; deployment timing and exact command require user choice before cycle 1; evidence: `package.json`.
- The user selected no deployment and explicitly requires all 128 invocation cycles to run even if ordinary RPF convergence or stall conditions would stop earlier; evidence: conversational instruction epoch 2.
- Cycle 1 independently verified 25 actionable root causes across searchable retention, performance, CLI/MCP UX, portability, security, and tests; every one of the 34 raw findings survived its kill gate, with duplicate agreement raising confidence; evidence: `.context/reviews/R1-verify.md`, `.context/reviews/R1-merged.md`.
- Cycle 1 integrated and published 22 verified fixes at signed commit `a0fd3a2be20fab93da5b7c9e70ea2f6b413e4304`; all four configured gates passed, with 356 tests (355 pass, one expected skip, zero failures).
- Cycle 2 independently verified 15 root causes: the three existing carryovers plus twelve new critical/high/medium/low gaps in batch memory/isolation, execution status, hook ownership, response caps, CLI validation, portability, SSRF, uninstall cleanup, and test contracts; evidence: `.context/reviews/R2-merged.md`, `.context/reviews/R2-verify.md`.

## Goal gaps

| ID | Status | Rev | Gap | Evidence | Detail shard |
|---|---|---:|---|---|---|
| GAP-001 | resolved | 2 | Independent review has not yet identified and verified concrete performance, UX, correctness, security, reliability, or documentation improvements. | Cycle 1 verified 25 actionable root causes; `.context/reviews/R1-merged.md`. | - |
| GAP-002 | resolved | 2 | Deployment mode is `none`; no publish or release command is authorized. | User selected option 3 at instruction epoch 2. | - |
| GAP-003 | open | 3 | Verified performance defects remain in exercised executor and batch hot paths. | RPF-026 and RPF-035 survived cycle-2 adversarial verification; `.context/reviews/R2-verify.md`. | - |
| GAP-004 | open | 3 | Verified CLI, MCP, plugin, setup, diagnostics, and documentation UX defects remain. | RPF-017, RPF-027 through RPF-030, RPF-033, and RPF-036 survived cycle-2 verification. | - |
| GAP-005 | open | 3 | Verified security boundary defects remain in hook ownership and NAT64 destination validation. | RPF-029 and RPF-034 survived cycle-2 adversarial verification. | - |
| GAP-006 | open | 3 | Verified correctness and regression-test gaps remain. | RPF-024, RPF-025, RPF-031, RPF-032, RPF-036, and RPF-037 remain pending. | - |

## Work queue

| ID | Status | Sev | Prio | Deps | Owner | Claim expires (UTC) | Rev | Task | Acceptance criteria | Evidence | Detail shard |
|---|---|---|---|---|---|---|---|---|---|---|---|
| RPF-001 | done | high | 0 | - | - | - | 4 | Preserve bounded pre-filter stdout for index-backed tools and index full executor-capped batch content separately from response caps. | A sentinel removed from displayed output remains searchable in execute-with-intent, execute_file, fetch_and_index, and batch_execute; response caps remain bounded. | Implemented across executor/index-backed tools; targeted tests and all configured gates passed at `a0fd3a2`. | - |
| RPF-002 | done | high | 0 | RPF-001 | - | - | 5 | Surface batch command exit, killed/truncated state, and stderr in inventory and indexed content. | Mixed success/nonzero batch calls expose exit state and stderr and keep diagnostics searchable without discarding successful results. | Implemented in src/tools/batch-execute.ts; targeted tests and all configured gates passed at `a0fd3a2`. | - |
| RPF-003 | done | high | 0 | - | - | - | 4 | Reject non-positive or fractional MCP search limits and defensively clamp valid limits. | Negative, zero, and fractional limits fail validation; positive over-limit values return at most configured searchLimit. | Implemented in src/tools/search.ts with schema/handler regression; all configured gates passed at `a0fd3a2`. | - |
| RPF-004 | done | high | 0 | RPF-001 | - | - | 5 | Stop eager cloning/buffering of lengthless fetch responses in JS/TS execution tracking. | Chunked fetch resolves before body completion while Content-Length accounting remains correct and tests are deterministic. | Implemented in src/executor.ts; deterministic regression and all configured gates passed at `a0fd3a2`. | - |
| RPF-005 | done | high | 0 | - | - | - | 4 | Bound buffered CLI wrap capture and report cap termination explicitly. | Buffered stdout/stderr never exceeds an injected cap; overflow terminates cleanly and returns an actionable cap marker. | Implemented in src/cli/filter.ts; bounded-capture regression and all configured gates passed at `a0fd3a2`. | - |
| RPF-006 | done | high | 0 | - | - | - | 4 | Restore persisted trigram-table state without duplicate backfill. | File-backed close/reopen/miss keeps trigram rows and public fuzzy results stable and new chunks remain indexed. | Implemented in src/store.ts; persistence regression and all configured gates passed at `a0fd3a2`. | - |
| RPF-007 | done | high | 0 | - | - | - | 4 | Distinguish owned setup hooks, repair stale owned paths, and preserve unrelated pretooluse hooks. | Setup appends beside unrelated hooks and updates a known stale context-compress hook exactly once with reported changes. | Implemented in src/cli/setup.ts; setup regression and all configured gates passed at `a0fd3a2`. | - |
| RPF-008 | done | high | 0 | - | - | - | 4 | Generate valid Go package wrappers that preserve imports and expose FILE_CONTENT. | Package programs with no imports, existing imports, existing os import, and CRLF generate valid ordered code with FILE_CONTENT. | Implemented in src/runtime/languages/go.ts; generated-code regression and all configured gates passed at `a0fd3a2`; optional compiler test skipped because Go unavailable. | - |
| RPF-009 | done | high | 0 | - | - | - | 4 | Make project-path containment platform-aware. | Windows/POSIX descendants and roots pass; prefix siblings, traversal, and cross-drive paths fail in both realpath and fallback cases. | Implemented in src/util/path.ts; portability regression and all configured gates passed at `a0fd3a2`. | - |
| RPF-010 | done | high | 0 | RPF-004 | - | - | 4 | Remove the attacker-owned fixed executor temp parent. | Execution uses a direct random private temp leaf under the OS temp root, ignores a hostile legacy parent, and cleans up. | Implemented in src/executor.ts; 18-case executor regression and all configured gates passed at `a0fd3a2`. | - |
| RPF-011 | done | high | 0 | - | - | - | 4 | Validate hook mode/bin configuration and shell-quote supported command tokens. | Invalid or metacharacter-bearing mode/bin values do not rewrite; valid package/absolute/node/tsx commands and space-bearing paths are quoted safely. | Implemented in src/hooks/pretooluse.ts; injection/compatibility regressions and all configured gates passed at `a0fd3a2`. | - |
| RPF-012 | done | high | 1 | RPF-001,RPF-002 | - | - | 4 | Qualify searchable-retention documentation for ordinary execute and wrap while documenting verified index-backed behavior. | README/plugin/docs no longer claim ordinary no-intent execute or wrap retain searchable raw data; examples match code. | Corrected five docs/manifests; consistency checks and all configured gates passed at `a0fd3a2`. | - |
| RPF-013 | done | high | 0 | - | - | - | 4 | Make the Windows plugin hook invoke the bundled quoted CLI path. | commandWindows derives dist/cli/index.js from CLAUDE_PLUGIN_ROOT, handles spaces, and never requires a global context-compress binary. | Implemented in hooks/claude-codex-hooks.json; Windows path regression and all configured gates passed at `a0fd3a2`. | - |
| RPF-014 | done | medium | 1 | RPF-007 | - | - | 5 | Make setup --no-filter-bash remove only owned filter env keys. | Enabled-to-disabled transition removes CONTEXT_COMPRESS_FILTER_BASH/BIN, reports changes, and preserves unrelated env. | Implemented in src/cli/setup.ts; transition/idempotency regression and all configured gates passed at `a0fd3a2`. | - |
| RPF-015 | done | medium | 2 | - | - | - | 4 | Align hook configuration implementation and README file-config contract. | Hook controls either load project/home config with documented precedence or docs/schema clearly mark them environment-only; tests prove the chosen contract. | Documented hook controls as environment-only, removed misleading schema, and passed targeted regressions plus all configured gates at `a0fd3a2`. | - |
| RPF-016 | done | medium | 2 | - | - | - | 4 | Correct the vulnerability-reporting route to the canonical Open330 private channel. | SECURITY.md names the authorized Open330 channel and a consistency test detects owner drift. | Corrected SECURITY.md; security-doc regression and all configured gates passed at `a0fd3a2`. | - |
| RPF-017 | active | medium | 0 | RPF-011,RPF-014 | rpf-codex-20260810T061531Z-9935 | 2026-08-10T09:49:45Z | 5 | Quote generated setup hook/bin/manual command paths across supported shells. | Paths containing spaces, quotes, metacharacters, and Windows separators remain one inert argument in generated commands. | Five cycle-2 reviewers and the kill gate confirmed the issue; implement setup serialization plus parser compatibility as one scope. | - |
| RPF-018 | done | medium | 1 | - | - | - | 5 | Make the shipped doctor skill use a location-independent executable diagnostic path. | The exact shipped skill action succeeds from an isolated execution cwd and returns a doctor report. | Implemented in skills/doctor/SKILL.md; isolated-cwd regression and all configured gates passed at `a0fd3a2`. | - |
| RPF-019 | done | medium | 1 | - | - | - | 5 | Add full CLI help, version, and actionable unknown-command routing. | No args starts MCP; help/version exit 0 with useful text; typo exits 2 on stderr without starting MCP. | Implemented in src/cli/index.ts; five CLI subprocess regressions and all configured gates passed at `a0fd3a2`. | - |
| RPF-020 | done | medium | 1 | - | - | - | 6 | Enforce content XOR path for the index MCP tool. | Content-only and path-only succeed; both and neither return one actionable validation error. | Implemented in src/tools/index-content.ts; four-case handler regression and all configured gates passed at `a0fd3a2`. | - |
| RPF-021 | done | medium | 1 | - | - | - | 5 | Redact common npm, fine-grained GitHub, and underscore-delimited secret assignments before auto-mode calls. | Exact npm_, github_pat_, and AWS_SECRET_ACCESS_KEY samples are absent from outbound prompts without over-redacting ordinary variables. | Implemented in src/util/auto-mode.ts; secret/benign regressions and all configured gates passed at `a0fd3a2`. | - |
| RPF-022 | done | medium | 1 | - | - | - | 6 | Reject non-global-unicast IPv4/IPv6 destinations for raw literals and DNS answers. | Table-driven special-use ranges including 198.18/15 and ff00::/8 reject while global controls pass. | Implemented in src/network.ts; 35 raw/DNS/boundary regressions and all configured gates passed at `a0fd3a2`. | - |
| RPF-023 | done | medium | 1 | - | - | - | 5 | Put ephemeral SQLite databases and sidecars in private random directories and remove them on close. | Default store uses mode-0700 random parent, avoids PID path, and removes DB/WAL/SHM directory on close. | Implemented in src/store.ts; lifecycle/trigram regressions and all configured gates passed at `a0fd3a2`. | - |
| RPF-024 | active | medium | 0 | RPF-010 | rpf-codex-20260810T061531Z-9935 | 2026-08-10T09:49:45Z | 5 | Add timeout, output-cap, killed-result, and process-tree executor regressions. | Deterministic tests assert bounded completion, killed/nonzero diagnostics, cap marker, and no surviving POSIX grandchild. | Cycle-2 reviewers confirmed the leaked helpers/config remain unused; serialize before RPF-025. | - |
| RPF-025 | pending | low | 1 | RPF-024 | - | - | 2 | Return immediately from all runtime t.skip guards. | Node-only PATH run exits cleanly with skips and no assertion-error section. | Four cycle-2 reviewers reproduced nine non-returning guards and suppressed assertion diagnostics. | - |
| RPF-026 | active | critical | 0 | - | rpf-codex-20260810T061531Z-9935 | 2026-08-10T09:49:45Z | 2 | Bound batch request arrays and release each command corpus after immediate indexing. | Schema rejects pathological command/query counts; indexing begins before all commands settle; peak retained result memory is bounded by concurrency while full capped corpora stay searchable and response order remains stable. | R2-performance-reviewer-1; verifier measured +165.7 MiB RSS for 64 x 2 MiB outputs. | - |
| RPF-027 | active | high | 0 | RPF-001 | rpf-codex-20260810T061531Z-9935 | 2026-08-10T09:49:45Z | 2 | Surface exit, killed, truncated, and stderr status from execute and execute_file. | Public handlers distinguish exit 0 from nonzero/killed/capped results, preserve useful output, and return stable actionable diagnostics with handler regressions. | R2-api-dx-reviewer-1; exit 7 and exit 0 currently return indistinguishable empty success responses. | - |
| RPF-028 | active | high | 0 | RPF-002 | rpf-codex-20260810T061531Z-9935 | 2026-08-10T09:49:45Z | 2 | Restrict batch query results to sources created by the current invocation. | A two-call regression proves a second batch cannot retrieve a first-batch sentinel; current-call results and fallback behavior remain explicit. | R2-api-dx-reviewer-2; kill gate reproduced stale first-call evidence in the second response. | - |
| RPF-029 | pending | high | 0 | RPF-017 | - | - | 1 | Use context-compress-specific hook ownership in setup and uninstall while preserving mixed entries. | Unrelated generic pretooluse.mjs hooks are never overwritten/deleted; owned hooks update/remove exactly; sibling hooks survive; setup/uninstall share tested ownership semantics. | R2-code-quality-reviewer-2, R2-pointer-alignment-1, R2-security-reviewer-2; kill gate reproduced overwrite and whole-entry deletion. | - |
| RPF-030 | active | medium | 1 | - | rpf-codex-20260810T061531Z-9935 | 2026-08-10T09:49:45Z | 2 | Reject invalid, missing, and unknown filter/wrap CLI options. | Explicit invalid/missing modes and unknown flags exit 2 on stderr with accepted values; documented valid/default/environment modes retain behavior. | R2-api-dx-reviewer-4; probes showed invalid inputs exit 0 and silently select balanced or reach the shell. | - |
| RPF-031 | active | medium | 1 | RPF-008 | rpf-codex-20260810T061531Z-9935 | 2026-08-10T09:49:45Z | 2 | Handle blank-imported Go os packages when generating FILE_CONTENT wrappers. | `import _ "os"` never generates `_.ReadFile`; generated code uses a callable os import and a regression covers the legal blank-import form. | R2-code-quality-reviewer-3; verifier reproduced invalid generated `b, _ := _.ReadFile(...)`. | - |
| RPF-032 | pending | medium | 1 | RPF-026,RPF-028 | - | - | 1 | Enforce configured byte budgets over complete search and batch responses. | Search and batch text never exceed their configured UTF-8 byte budgets, including inventory/metadata/separators; oversized blocks truncate with an actionable bounded marker. | R2-code-quality-reviewer-4, R2-pointer-alignment-3; 1024-byte probes returned 1526 and 1573 bytes. | - |
| RPF-033 | pending | medium | 1 | RPF-029 | - | - | 1 | Remove only setup-owned Bash filter environment keys during uninstall. | Uninstall removes CONTEXT_COMPRESS_FILTER_BASH/BIN, preserves unrelated env, reports changes, and is idempotent. | R2-pointer-alignment-2; setup writes both keys but uninstall never touches env. | - |
| RPF-034 | active | medium | 1 | RPF-022 | rpf-codex-20260810T061531Z-9935 | 2026-08-10T09:49:45Z | 2 | Reject NAT64 literals that translate to non-global IPv4 destinations. | Well-known NAT64 prefix cases embedding loopback/link-local/private/documentation IPv4 reject while global translated controls pass for raw literals and resolution. | R2-security-reviewer-3; kill gate reproduced acceptance of 64:ff9b::7f00:1 and 64:ff9b::a9fe:a9fe. | - |
| RPF-035 | pending | medium | 1 | RPF-024 | - | - | 1 | Reuse one ANSI-normalized executor stdout for indexing and response filtering. | Executor strips the retained corpus once, preserves cap-marker behavior, and a regression or measurement proves no duplicate full scan. | R2-performance-reviewer-2; source and kill gate confirm two stripAnsi passes. | - |
| RPF-036 | active | medium | 1 | RPF-019 | rpf-codex-20260810T061531Z-9935 | 2026-08-10T09:49:45Z | 2 | Contract-test empty-argument CLI MCP startup. | A subprocess sends MCP initialize to the empty-argv CLI, receives a valid JSON-RPC response, exits cleanly, and remains deterministic offline. | R2-testing-reviewer-3; live behavior works but no regression covers the published startup contract. | - |
| RPF-037 | pending | low | 2 | RPF-034 | - | - | 1 | Restore DNS global mocks on every test path. | All dns.promises.lookup replacements restore in finally/afterEach and an injected failure cannot leak a mock to the next test. | R2-testing-reviewer-4 corrected by verifier to five success-only restoration paths. | - |

Statuses: `pending`, `active`, `integrated`, `blocked`, `deferred`, `done`.
`Sev`: `critical`, `high`, `medium`, `low`. `Prio` is a non-negative integer;
lower runs first. `Deps` is comma-separated work IDs or `-`. `Owner` is the
claiming `Run ID`; clear it and `Claim expires` when the item leaves `active`.

## Durable record index

| Record ID | Kind | Rev | Disposition or result | Compact evidence | Shard ID |
|---|---|---:|---|---|---|

## Deferred findings

| ID | Sev | Confidence | Evidence (file:line) | Reason | Reopen when | Repo rule | Detail shard |
|---|---|---|---|---|---|---|---|

## Refuted findings

| Cycle | ID | Claim | Refuting evidence | Detail shard |
|---|---|---|---|---|

## Feedback

| ID | Source | Cycle | Feedback | Disposition |
|---|---|---|---|---|
| USER-001 | user | bootstrap | Run RPF for up to 128 cycles to improve performance, UI/UX, and other service quality. | GAP-001 |
| USER-002 | user | bootstrap | Do not deploy. | resolved as DEPLOY_MODE=none |
| USER-003 | user | bootstrap | Do not stop until RPF invocation cycle 128 completes. | governing run policy through cycle 128 |
| R1-FEEDBACK | seven independent reviewers plus seventeen kill-gate verifiers | 1 | Thirty-four findings survived verification and deduplicated into 25 actionable root causes. | RPF-001 through RPF-025; `.context/reviews/R1-verify.md` |
| R2-FEEDBACK | seven independent reviewers plus six kill-gate verifiers | 2 | Twenty-six raw findings deduplicated into fifteen verified roots: three carryovers and twelve new work items. | RPF-017, RPF-024 through RPF-037; `.context/reviews/R2-merged.md`, `.context/reviews/R2-verify.md` |

## Decision log

| Rev | Cycle | Run | Decision | Reason and evidence |
|---|---|---|---|---|
| 1 | bootstrap | rpf-codex-20260810T061531Z-9935 | Interpret UI/UX as CLI, MCP, plugin, setup/doctor, messages, documentation, and perceived performance. | No graphical UI assets exist; user-facing surfaces are under `src/cli/`, `src/tools/`, plugin manifests, skills, and `README.md`. |
| 1 | bootstrap | rpf-codex-20260810T061531Z-9935 | Preserve the dirty primary checkout and use a dedicated integration worktree for implementation. | RPF git-containment policy and invocation-start `git status`. |
| 1 | bootstrap | rpf-codex-20260810T061531Z-9935 | Keep `.context/reviews/` ignored and retain only the last five review cycles. | Review artifacts are operational provenance and 128-cycle output should not become incidental repository history. |
| 2 | bootstrap | rpf-codex-20260810T061531Z-9935 | Set DEPLOY_MODE to `none`. | User selected deployment option 3; no deploy command will be run. |
| 2 | bootstrap | rpf-codex-20260810T061531Z-9935 | Continue through exactly 128 invocation cycles even after ordinary convergence or stall signals. | Newest explicit user instruction at epoch 2 overrides the skill's default early-stop behavior for this invocation; safety, authorization, and unrecoverable-error stops still apply. |
| 5 | 1 | rpf-codex-20260810T061531Z-9935 | Treat repeated reviewer findings as one root-cause work item while preserving every source finding ID in evidence. | RPF aggregation requires deduplication by root cause; `.context/reviews/R1-merged.md`. |
| 5 | 1 | rpf-codex-20260810T061531Z-9935 | Correct broad ordinary-execute/wrap retention claims in documentation rather than silently adding automatic storage. | Auto-indexing those paths changes privacy, storage, lifecycle, and lite-CLI architecture; verifier evidence supports a truthful-docs fix while RPF-001 fixes existing index-backed paths. |
| 15 | 2 | rpf-codex-20260810T061531Z-9935 | Treat generic hook ownership as one coordinated setup/uninstall defect and serialize it after RPF-017. | Three independent reviewers and a kill-gate reproduction show the same basename-only ownership root cause; setup/parser quoting changes overlap the same files and must land first. |

## Verification evidence

| Cycle | Run | Work ID or criterion | Evidence | Result |
|---|---|---|---|---|
| 1 | rpf-codex-20260810T061531Z-9935 | RPF-001 through RPF-016 and RPF-018 through RPF-023 | Controller accepted targeted regressions for all 22 items and published signed commit `a0fd3a2be20fab93da5b7c9e70ea2f6b413e4304`. | pass |
| 1 | rpf-codex-20260810T061531Z-9935 | configured gates | `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` passed on committed HEAD `a0fd3a2`; test result 356 total, 355 pass, one expected skip, zero failures. | pass |
| 1 | rpf-codex-20260810T061531Z-9935 | publication | Fast-forward push `3125f91..a0fd3a2` to `origin/fix/fetch-pinning-and-destructive-filters` succeeded; deployment mode remained none. | pass |

## Cycle telemetry

| Cycle | Run | Review agents | Verify agents | Work agents | Runnable | Local | Peak | Serialization | Prefetch |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| 1 | rpf-codex-20260810T061531Z-9935 | 7 | 17 | 24 | 48 | 22 | 17 | dependency,overlap,controller-only | reused=0;produced=0;discarded=none |
<!-- rpf:managed:end -->
