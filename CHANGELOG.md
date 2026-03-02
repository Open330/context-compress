# Changelog

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
