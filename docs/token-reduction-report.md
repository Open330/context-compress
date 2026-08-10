# Token Reduction Report

**How context-compress achieves 99%+ context savings — with real numbers.**

> This document explains the mechanism behind context-compress's token reduction,
> provides a detailed before/after comparison for 12 common operations,
> and addresses the natural question: "doesn't less tokens mean losing context?"

**Version**: 2026.5.0 | **Last updated**: 2026-05-10

---

## Table of Contents

- [The Problem](#the-problem)
- [The Solution: 3-Layer Architecture](#the-solution-3-layer-architecture)
- [Before / After: 12 Real Operations](#before--after-12-real-operations)
- [Session Totals](#session-totals)
- [Context Window Impact](#context-window-impact)
- [Cost Impact](#cost-impact)
- [Deep Dive: How Playwright Snapshot Goes from 56KB to 299B](#deep-dive-how-playwright-snapshot-goes-from-56kb-to-299b)
- [Security and Reliability](#security-and-reliability)
- [FAQ: Doesn't Less Tokens Mean Losing Context?](#faq-doesnt-less-tokens-mean-losing-context)

---

## The Problem

Every byte of tool output that enters Claude Code's context window **consumes tokens permanently**. In a typical coding session:

```
Read a bundled file          →  776KB  →  155K-259K tokens
Playwright browser snapshot  →   56KB  →   11K-19K tokens
npm test (42 tests)          →    4KB  →     748-1,246 tokens
git diff (3 commits)         →    8KB  →   1,600-2,667 tokens
                                         ─────────────────
                                Total:    169K-282K tokens
                                         ← can overflow 200K window
```

> **Token estimation**: 1 token ≈ 3-5 bytes depending on content. We use a range (bytes/5 to bytes/3) because Anthropic does not publish a local tokenizer for Claude 3+ models.

With just 4 operations, you risk **overflowing the entire context window**. Earlier conversation messages get compressed or lost. The agent forgets what you asked. Quality degrades.

The worst part: **99% of that tool output is noise** — import statements, boilerplate, minified code, irrelevant test output. The agent doesn't benefit from seeing it. It just crowds out the conversation.

---

## The Solution: 4-Layer Architecture

context-compress has two distinct paths. Response-only calls compress what enters context; details they omit are not retained. Index-backed calls preserve a bounded corpus in FTS5 so only relevant parts enter context while the indexed data remains searchable.

### Layer 0: Command-Specific Output Filters (v2026.3.22)

Before generic compression, output passes through command-aware filters that strip noise specific to each tool:

| Command | What's Stripped | Typical Savings |
|:--|:--|:--|
| `git push/pull/fetch/clone` | Remote progress lines, object counting, delta resolution | 40-60% |
| `git status` | Hint lines (`use "git add"...`), blank lines | 20-30% |
| `npm/yarn/pnpm install` | Deprecation warnings, funding prompts, tree-drawing chars | 30-50% |
| `npm test / jest / vitest / pytest` | Passing test details, keeps only failures + summary | 70-95% |
| `cargo build / make / gradle` | Download progress, "Compiling X/Y", lock waits | 50-70% |
| `docker build` | Layer hash lines (` ---> abc123`), build context transfer | 30-50% |
| `ls -R / find / tree` | Directory grouping for large listings (50+ files) | 60-80% |

Additionally, all output passes through:
- **ANSI stripping**: Terminal escape codes (colors, cursor movement) are always removed — pure noise for LLMs
- **Progress line removal**: Spinner characters, percentage bars, download/ETA lines are filtered

These filters only change the returned response. CLI `wrap`/`filter` and an
ordinary `execute` call without `intent` do not automatically store the original,
so detail removed here is not available to `search`.

### Layer 1: Sandbox Execution

The agent writes code to process data. Only `console.log()` output enters context. 11 languages supported: JavaScript, TypeScript, Python, Shell, Ruby, Go, Rust, PHP, Perl, R, Elixir.

```
execute_file("server.bundle.mjs", code: `
  const match = FILE_CONTENT.match(/CREATE VIRTUAL TABLE.*?;/s)
  console.log(match[0])  // ← ONLY this enters context
`)

Full file: 776,304 bytes (stays in subprocess)
Context:       420 bytes (the extracted schema)
```

The agent isn't blindly losing context — it's **choosing** what matters via code.

**Safeguards**: Code input limited to 1MB. Subprocess timeout (default 30s). Output hard cap (100MB). Process group kill on timeout. Concurrent executions limited to 8 globally.

### Layer 2: FTS5 Knowledge Base

Content sent through `index`, `fetch_and_index`, or `batch_execute` is stored in a searchable SQLite FTS5 database with BM25 ranking, Porter stemming, trigram matching, and Levenshtein fuzzy correction (with early-exit optimization). A large `execute` call also uses this path when it includes `intent`.

```
index(path: "snapshot.md")          → 56KB stored, 42 chunks created
search("login form")                → 169B match returned
search("navigation menu")           → 200B match returned
search("order table row headers")   → 180B match returned
```

For these index-backed calls, the bounded indexed corpus remains searchable on demand.

**Persistence option**: Set `persistDb: true` in config to survive MCP server restarts.

### Layer 3: Intent-Based Auto-Filter

When the agent provides an `intent` parameter, large outputs are automatically filtered:

```
execute(code: "npm test", intent: "failing tests")

Output < 5KB  →  returned as-is (no compression)
Output > 5KB  →  executor-capped pre-filter output indexed; only intent-matching sections returned
```

On this intent path, small outputs pass through without indexing. Large outputs are indexed from the executor-capped copy captured before lossy command, format, deduplication, and response-truncation filters, then filtered by what was actually asked for.

---

## Before / After: 12 Real Operations

The following comparison uses realistic output sizes measured from the context-compress project itself.

> **Token calculation**: 1 token ≈ 3-5 bytes. The "Tokens" column shows the midpoint estimate (bytes/4). See [Cost Impact](#cost-impact) for range-based calculations.

### 1. Read large source file (server.ts ~21KB)

| | Bytes | Tokens (est.) | Method |
|:--|--:|--:|:--|
| **Before** | 21,000 | ~5,250 | `Read` tool → full file dumped into context |
| **After** | 350 | ~88 | `execute_file` → agent prints only what it needs |
| **Saved** | | **~5,162** | **98.3% reduction** |

### 2. Read bundled file (server.bundle.mjs ~776KB)

| | Bytes | Tokens (est.) | Method |
|:--|--:|--:|:--|
| **Before** | 776,304 | ~194,076 | `Read` tool → full file in context (truncated at 2000 lines) |
| **After** | 420 | ~105 | `execute_file` → extract specific function/pattern |
| **Saved** | | **~193,971** | **99.9% reduction** |

### 3. npm test output (42 tests, ~3.7KB)

| | Bytes | Tokens (est.) | Method |
|:--|--:|--:|:--|
| **Before** | 3,739 | ~935 | `Bash` → full stdout in context |
| **After** | 180 | ~45 | `execute` with `intent: "failing tests"` → summary only |
| **Saved** | | **~890** | **95.2% reduction** |

### 4. git log (full history, ~5KB)

| | Bytes | Tokens (est.) | Method |
|:--|--:|--:|:--|
| **Before** | 5,000 | ~1,250 | `Bash git log` → all commits in context |
| **After** | 250 | ~63 | `execute` with `intent` + `search` for specific commits |
| **Saved** | | **~1,187** | **95.0% reduction** |

### 5. git diff (3 commits, ~8KB)

| | Bytes | Tokens (est.) | Method |
|:--|--:|--:|:--|
| **Before** | 8,000 | ~2,000 | `Bash git diff` → full patch in context |
| **After** | 400 | ~100 | `execute` with `intent` + `search` for changed functions |
| **Saved** | | **~1,900** | **95.0% reduction** |

### 6. grep across codebase (~1.4KB)

| | Bytes | Tokens (est.) | Method |
|:--|--:|--:|:--|
| **Before** | 1,442 | ~361 | `Grep` → all matching lines in context |
| **After** | 1,442 | ~361 | Same — small output passes through as-is |
| **Saved** | | **0** | **0% — no overhead for small outputs** |

### 7. Playwright browser_snapshot (~56KB)

| | Bytes | Tokens (est.) | Method |
|:--|--:|--:|:--|
| **Before** | 56,000 | ~14,000 | `browser_snapshot` → full accessibility tree in context |
| **After** | 299 | ~75 | save → `index` → `search` for specific elements |
| **Saved** | | **~13,925** | **99.5% reduction** |

### 8. curl API response (JSON ~12KB)

| | Bytes | Tokens (est.) | Method |
|:--|--:|--:|:--|
| **Before** | 12,000 | ~3,000 | `Bash curl` → full JSON response in context |
| **After** | 350 | ~88 | `execute` → extract specific fields with code |
| **Saved** | | **~2,912** | **97.1% reduction** |

### 9. fetch_and_index (web docs ~45KB)

| | Bytes | Tokens (est.) | Method |
|:--|--:|--:|:--|
| **Before** | 45,000 | ~11,250 | `WebFetch` → full page markdown in context |
| **After** | 3,000 | ~750 | `fetch_and_index` → 3KB preview + rest searchable |
| **Saved** | | **~10,500** | **93.3% reduction** |

**Security**: SSRF protection with DNS rebinding prevention, IP pinning, redirect blocking, and 10MB response size limit. Prompt injection detection on fetched content.

### 10. batch_execute (5 commands, ~25KB total)

| | Bytes | Tokens (est.) | Method |
|:--|--:|--:|:--|
| **Before** | 25,000 | ~6,250 | 5x `Bash` → all output in context |
| **After** | 1,500 | ~375 | `batch_execute` + search across all in 1 call |
| **Saved** | | **~5,875** | **94.0% reduction** |

**Performance**: Commands run with bounded concurrency (max 4 parallel). Global execution limit of 8 prevents resource exhaustion.

### 11. Read CSV/JSON data file (~100KB)

| | Bytes | Tokens (est.) | Method |
|:--|--:|--:|:--|
| **Before** | 100,000 | ~25,000 | `Read` → file contents in context |
| **After** | 500 | ~125 | `execute_file` → extract/aggregate specific data |
| **Saved** | | **~24,875** | **99.5% reduction** |

### 12. npm install log (~15KB)

| | Bytes | Tokens (est.) | Method |
|:--|--:|--:|:--|
| **Before** | 15,000 | ~3,750 | `Bash npm install` → full install log in context |
| **After** | 200 | ~50 | `execute` with `intent: "errors"` → only issues shown |
| **Saved** | | **~3,700** | **98.7% reduction** |

### 13. npm test with ANSI + verbose output (~8KB, v2026.3.22)

| | Bytes | Tokens (est.) | Method |
|:--|--:|--:|:--|
| **Before** | 8,000 | ~2,000 | `Bash npm test` → full ANSI-colored verbose output in context |
| **After** | 350 | ~88 | Command filter strips ANSI + passing tests → only failures + summary |
| **Saved** | | **~1,912** | **95.6% reduction** |

**Pipeline**: ANSI stripping → command filter (test runner detection) → progress line removal → deduplication → smart truncation. All 5 layers applied automatically.

---

## Session Totals

Combining all 13 operations from a single coding session:

```
BEFORE:  1,051 KB  →  ~263K tokens consumed (bytes/4 midpoint)
AFTER:       9 KB  →    ~2.3K tokens consumed
                       ────────────────────────
SAVED:   1,042 KB  →  ~260K tokens
REDUCTION:                99.1%
```

---

## Context Window Impact

Claude Code uses a 200K token context window.

```
┌─────────────────────────────────────────────────────────────┐
│                   200,000 token context window               │
│                                                              │
│  WITHOUT context-compress:                                   │
│  ████████████████████████████████████████████████████ ~132%  │
│  ← 13 operations OVERFLOW the window. Conversation lost.     │
│                                                              │
│  WITH context-compress:                                      │
│  █ ~1.2%                                                     │
│  ← 13 operations use ~1.2%. ~98.8% free for conversation.   │
└─────────────────────────────────────────────────────────────┘
```

| Metric | Before | After |
|:--|--:|--:|
| Tokens consumed (est.) | ~263,000 | ~2,300 |
| % of context window | ~132% | ~1.2% |
| Operations before compaction | ~9 | **~1,080** |
| Conversation longevity | Short | **~117x longer** |

---

## Cost Impact

Input token pricing (per session, 12 operations). Using midpoint estimate (bytes/4):

| Model | Before | After | Saved per Session |
|:--|--:|--:|--:|
| Haiku 4.5 ($0.80/MTok) | $0.21 | $0.002 | **$0.21** |
| Sonnet 4.6 ($3/MTok) | $0.78 | $0.007 | **$0.78** |
| Opus 4.6 ($15/MTok) | $3.92 | $0.033 | **$3.89** |

### Extrapolated Monthly Savings

| Usage | Haiku | Sonnet | Opus |
|:--|--:|--:|--:|
| 5 sessions/day | $31.05 | $116.44 | **$582.19** |
| 10 sessions/day | $62.10 | $232.88 | **$1,164.38** |
| 20 sessions/day | $124.20 | $465.75 | **$2,328.75** |

> Note: These are input token savings only. Actual savings vary based on session complexity. Output tokens are unaffected. Token estimates use bytes/4 midpoint; actual counts may vary 20-30%.

---

## Deep Dive: How Playwright Snapshot Goes from 56KB to 299B

This is the most dramatic example (99.5% reduction), so let's trace through it step by step.

### Before (without context-compress)

The `browser_snapshot()` tool returns a full accessibility tree:

```
- document [url="https://app.example.com/dashboard"]
  - banner
    - navigation "Main"
      - list
        - listitem
          - link "Home" [href="/"]
        - listitem
          - link "Products" [href="/products"]
        - listitem
          - link "Pricing" [href="/pricing"]
        - listitem
          - link "Settings" [href="/settings"]
  - main
    - heading "Dashboard" [level=1]
    - region "Stats"
      - heading "Monthly Revenue" [level=2]
      - text "$124,500"
      - heading "Active Users" [level=2]
      - text "3,847"
    - heading "Welcome back, John" [level=2]
    - paragraph "Here's what happened while you were away..."
    - form "Search"
      - searchbox "Search orders..." [placeholder]
    - form "Login"
      - textbox "Email" [required]
      - textbox "Password" [required]
      - button "Sign In"
    - table "Recent Orders"
      - rowgroup
        - row
          - columnheader "Order ID"
          - columnheader "Amount"
          - columnheader "Status"
        - row "Order #1234 - $99.00 - Shipped"
        - row "Order #1235 - $45.00 - Pending"
        - row "Order #1236 - $180.00 - Delivered"
        ... (hundreds more rows)
      ...
    - complementary "Sidebar"
      - heading "Related Articles" [level=2]
      - list
        - listitem
          - link "Getting Started Guide"
        - listitem
          - link "API Documentation"
        ... (dozens more items)
    - contentinfo "Footer"
      - paragraph "© 2024 Example Inc."
      - navigation "Footer Links"
        ... (more footer content)
  ... (thousands more lines for a real application)
```

**All 56,000 bytes (~14,000 tokens) dumped into context. Gone.**

The agent probably only needed the login form. But it paid for the entire page.

### After (with context-compress)

Three steps, total cost: 299 bytes.

**Step 1**: Save snapshot to file

```
browser_snapshot(filename: "/tmp/snap.md")
→ "Saved." (50 bytes in context)
```

**Step 2**: Index into FTS5

```
index(path: "/tmp/snap.md", source: "page snapshot")
→ "Indexed 'page snapshot': 42 chunks from /tmp/snap.md" (80 bytes in context)
```

**Step 3**: Search for what you actually need

```
search(queries: ["login form email password"], source: "page snapshot")
→
--- [page snapshot] chunk 17/42 ---
### main > form "Login"
- textbox "Email" [required]
- textbox "Password" [required]
- button "Sign In"

(169 bytes in context)
```

**Total: 50 + 80 + 169 = 299 bytes in context.**

```
Reduction: 1 - (299 / 56,000) = 99.47%
```

The other 55,701 bytes are still in FTS5 — fully searchable. Need the order table? Just `search("order table")`. Need the sidebar? `search("sidebar articles")`. Nothing is lost.

---

## Security and Reliability

context-compress v2026.5.0 includes comprehensive security and reliability features:

### Security

| Feature | Description |
|:--|:--|
| Environment isolation | Opt-in credential passthrough (`passthroughEnvVars` defaults to empty) |
| SSRF protection | 4-layer defense: hostname validation, DNS rebinding prevention, IP pinning, redirect blocking |
| Input limits | Code: 1MB max. Fetch response: 10MB max. Index content: 50MB max |
| Concurrency control | Global limit of 8 concurrent executions. batch_execute: max 4 parallel |
| Prompt injection detection | Regex-based advisory warnings on fetched content (7 patterns) |
| Path traversal protection | `realpathSync` with symlink resolution + project boundary enforcement |
| Process isolation | Timeout, output caps (100MB), process group kill, safe environment |

### Reliability

| Feature | Description |
|:--|:--|
| Graceful shutdown | Active subprocess tracking, SIGTERM/SIGINT cleanup, uncaughtException handling |
| DB resilience | In-memory fallback on disk-full. WAL mode for crash recovery. Stale DB cleanup |
| Output processing | ANSI stripping, progress line removal, command-specific filters, line deduplication, error grouping, smart 60/40 head/tail truncation |
| Cumulative stats | Cross-session token savings persisted to `stats.json` when `persistDb` is enabled |
| Search fallback | 3-layer: Porter stemming → trigram (lazy) → Levenshtein fuzzy correction |
| Configuration | ENV > file > defaults with Zod validation and sanity clamping |

For the full security model, see [SECURITY.md](../SECURITY.md).

---

## FAQ: Doesn't Less Tokens Mean Losing Context?

**This is the right question to ask.** If we're feeding the agent fewer tokens, doesn't it see less?

**Yes — and that's the point.** But "seeing less" is not the same as "losing context."

### The Key Insight: Passive Exposure vs Active Retrieval

```
WITHOUT context-compress (passive exposure):
┌──────────────────────────────────────────────────────┐
│ ~194,000 tokens loaded into context                   │
│                                                      │
│  99% = imports, boilerplate, minified code,          │
│        source maps, irrelevant functions...          │
│                                                      │
│  1%  = the actual function you care about            │
│                                                      │
│  Agent "sees" everything, but:                       │
│  - The 99% pushes out earlier conversation           │
│  - Context window overflows after a few operations   │
│  - Agent gets confused by irrelevant code            │
│  - Quality degrades as context fills up              │
└──────────────────────────────────────────────────────┘

WITH an index-backed context-compress flow (active retrieval):
┌──────────────────────────────────────────────────────┐
│ ~105 tokens loaded into context                       │
│                                                      │
│  100% = exactly the function you care about          │
│                                                      │
│  The other 99%?                                      │
│  - Stored in FTS5, searchable any time               │
│  - Agent can query with search() when needed         │
│  - Conversation history preserved in context          │
│  - Quality stays high across long sessions           │
└──────────────────────────────────────────────────────┘
```

### The Mental Model: Google vs Reading the Entire Internet

```
WITHOUT context-compress:
  "Here, read all 4.5 billion web pages, then answer my question."
  → Impossible. You overflow and forget the early pages.

WITH an index-backed context-compress flow:
  "All pages are indexed in Google. What do you want to search?"
  → You find exactly what you need. Nothing is lost.
```

### When There IS Actual Context Loss

To be honest, there are edge cases:

| Scenario | Risk Level | Mitigation |
|:--|:--|:--|
| A response-only `execute`, `wrap`, or `filter` omits needed detail | Medium | Re-run conservatively or send the original through `index`, `batch_execute`, or a large `execute` call with `intent` |
| Agent needs full file review (every line) | Medium | Use `Read` directly for small files — context-compress doesn't override built-in tools |
| Agent's search query misses relevant data | Low | Search again with different terms. FTS5 supports Porter stemming + trigram + fuzzy matching |
| Agent forgets to search for something | Low | Same risk as any agent workflow. Agent can always `search()` later |
| Small output on the intent-filter path | None | Outputs at or below the default 5KB intent threshold pass through without indexing |

### The Bottom Line

The alternative to context-compress isn't "the agent sees everything clearly." The alternative is:

1. Context window fills up after a few operations
2. Earlier conversation messages get compressed/lost
3. Agent forgets what you originally asked
4. Quality degrades with every tool call
5. Session ends prematurely

context-compress trades **passive exposure to noise** for **active retrieval of signal**. In practice, this is strictly better.

---

## How Each Tool Compresses

| Tool | Mechanism | Best For |
|:--|:--|:--|
| `execute` | Runs code in sandbox (11 languages). Large output is searchable only when `intent` triggers indexing | CLI commands, API calls, test runners |
| `execute_file` | Reads file into sandbox. Only printed summary enters context | Large source files, CSVs, logs, data files |
| `index` + `search` | FTS5 stores all data. BM25 returns only matching chunks | Documentation, snapshots, large datasets |
| `fetch_and_index` | HTML → markdown → FTS5. Returns 3KB preview + searchable index | Web pages, API docs, reference material |
| `batch_execute` | Runs N commands (max 4 parallel), indexes all output, searches across all in 1 call | Multi-step workflows, exploration |
| `discover` | Shows knowledge base inventory and optimization suggestions | Understanding available indexed data |
| `stats` | Real-time session statistics with token range estimates and cost | Monitoring compression effectiveness |

The core principle:

> **Response-only calls return compressed output and do not retain omitted detail. Index-backed calls keep a bounded searchable corpus in FTS5 and return only the answer.**

---

*Generated from real benchmarks on the context-compress v2026.5.0 codebase.*
*Token estimates use bytes/4 midpoint. Actual token counts may vary by 20-30% depending on content type.*
*See SECURITY.md for the full trust model and security architecture.*
