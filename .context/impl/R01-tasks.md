# R01: Test Suite Implementation for context-compress

## Project Info
- **Path**: ~/workspace-open330/context-compress
- **Language**: TypeScript (ESM, strict mode)
- **Test runner**: Node.js built-in (`node:test`, `node:assert`)
- **Execution**: `node --import tsx --test tests/**/*.test.ts`
- **tsconfig**: target ES2022, module Node16, verbatimModuleSyntax

## Important: Import Conventions
- All imports use `.js` extension (ESM convention): `import { foo } from "../../src/bar.js"`
- Use `import type` for type-only imports
- The project uses `type: "module"` in package.json

## Task 1: tests/unit/snippet.test.ts

Test `src/snippet.ts` exports: `positionsFromHighlight`, `stripMarkers`, `extractSnippet`

```ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { positionsFromHighlight, stripMarkers, extractSnippet } from "../../src/snippet.js";
```

Test cases:
- `positionsFromHighlight`: empty string returns [], string with \x02\x03 markers returns correct positions
- `stripMarkers`: removes \x02 and \x03 from text, passes through clean text unchanged
- `extractSnippet`: short text returned as-is, long text with highlights extracts windows around matches, no highlights returns original text

## Task 2: tests/unit/config.test.ts

Test `src/config.ts` exports: `loadConfig`, `getConfig`, `resetConfig`

```ts
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { loadConfig, resetConfig } from "../../src/config.js";
```

Test cases:
- Default config has `passthroughEnvVars: []`, `debug: false`, `blockCurl: true`
- `CONTEXT_COMPRESS_DEBUG=1` sets `debug: true`
- `CONTEXT_COMPRESS_PASSTHROUGH_ENV=GH_TOKEN,AWS_PROFILE` splits correctly
- `CONTEXT_COMPRESS_BLOCK_CURL=0` sets `blockCurl: false`
- Call `resetConfig()` in `beforeEach` to reset state between tests
- Use `process.env` manipulation (set before `loadConfig()`, delete after)

## Task 3: tests/unit/store.test.ts

Test `src/store.ts` exports: `ContentStore`, `cleanupStaleDbs`

```ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { ContentStore } from "../../src/store.js";
```

Test cases:
- `index()`: markdown content produces correct chunk count, code chunks detected
- `search()`: finds indexed content by keyword, returns empty for non-matching query
- Fuzzy correction: slightly misspelled word still returns results (e.g., "javscript" → "javascript")
- `getDistinctiveTerms()`: returns array of strings, excludes stopwords
- `getStats()`: returns correct totalSources and totalChunks after indexing
- Use `:memory:` database path for all tests

## Task 4: tests/unit/stats.test.ts

Test `src/stats.ts` export: `SessionTracker`

```ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { SessionTracker } from "../../src/stats.js";
```

Test cases:
- `trackCall()`: increments call count and bytes
- `trackIndexed()`: increments bytesIndexed
- `trackSandboxed()`: increments bytesSandboxed
- `getSnapshot()`: returns current state
- `formatReport()`: returns string containing "Session Statistics", includes savings ratio

## Task 5: tests/unit/executor.test.ts

Test `src/executor.ts` export: `SubprocessExecutor`

```ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { SubprocessExecutor } from "../../src/executor.js";
import { detectRuntimes } from "../../src/runtime/index.js";
import { loadConfig, resetConfig } from "../../src/config.js";
```

Test cases:
- JavaScript execution: `console.log("hello")` → stdout contains "hello", exitCode 0
- Python execution: `print("hello")` → stdout contains "hello", exitCode 0
- Shell execution: `echo hello` → stdout contains "hello", exitCode 0
- Invalid language returns error in stderr
- Credential passthrough disabled by default: set `AWS_ACCESS_KEY_ID` in process.env, run `printenv` via shell, verify the key is NOT in output (since passthroughEnvVars is [])
- Each test needs `await detectRuntimes()` and `loadConfig()` (call `resetConfig()` first)
- Tests are async, use reasonable timeout (10s)

## Task 6: tests/unit/runtime.test.ts

Test `src/runtime/index.ts` and language plugins

```ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { detectRuntimes, ALL_PLUGINS } from "../../src/runtime/index.js";
```

Test cases:
- `detectRuntimes()`: returns a Map, has at least "javascript" and "shell"
- `ALL_PLUGINS`: has exactly 11 plugins
- JavaScript plugin: `buildCommand("node", "/tmp/test.js")` → `["node", "/tmp/test.js"]`
- Go plugin: `preprocessCode("fmt.Println(42)")` wraps in package main
- Rust plugin: `compileStep` returns array with rustc (no shell string)
- PHP plugin: `preprocessCode` adds `<?php` tag

## Task 7: tests/unit/pretooluse.test.ts

The pretooluse hook reads from stdin and writes to stdout. Test it by spawning the process.

```ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
```

Use `execFileSync("node", ["--import", "tsx", hookPath], { input: JSON.stringify(payload) })` to test.

Hook path: `../../src/hooks/pretooluse.ts`

Test cases:
- Bash with curl command → output contains "blocked" in updatedInput.command
- Bash with normal command (e.g., "git status") → exits with no output (passthrough)
- WebFetch → output contains "permissionDecision": "deny"
- Read → output contains "additionalContext" with tip
- Grep → output contains "additionalContext" with tip
- With `CONTEXT_COMPRESS_BLOCK_CURL=0` env, curl is NOT blocked (passthrough)

## Task 8: tests/integration/server.test.ts

Integration test for MCP server tool chain. Since starting a full MCP server is complex, test the underlying components together.

```ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { SubprocessExecutor } from "../../src/executor.js";
import { ContentStore } from "../../src/store.js";
import { detectRuntimes } from "../../src/runtime/index.js";
import { loadConfig, resetConfig } from "../../src/config.js";
```

Test cases:
- Execute JS code → index output → search finds it
- Execute Python → output is correct
- Index markdown → search by heading title → returns matching chunk
- Stats integration: track calls, verify report generation

## Task 9: tests/integration/batch.test.ts

Test batch_execute-style workflow: run multiple shell commands, index combined output, search.

Test cases:
- Run 3 shell commands via executor: `echo "section1"`, `echo "section2"`, `echo "section3"`
- Combine outputs with markdown headers
- Index into store
- Search for each section by keyword

## Task 10: tests/integration/fetch.test.ts

Test the HTML-to-markdown conversion used by fetch_and_index (without actually fetching a URL).

Test cases:
- Execute the HTML conversion JS code with a sample HTML string (hardcoded)
- Verify headings are converted to markdown `#`
- Verify `<script>` and `<style>` tags are stripped
- Verify links converted to `[text](url)` format
- Index the result and search

## Execution Order
All tasks are independent and can be implemented in parallel. After creating all files, run:
```bash
node --import tsx --test tests/unit/*.test.ts
node --import tsx --test tests/integration/*.test.ts
```

Fix any failing tests before considering done.
