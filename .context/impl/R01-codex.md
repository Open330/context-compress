Implemented all 10 requested test files with Node’s built-in runner and ESM `.js` imports:

- [tests/unit/snippet.test.ts](/tmp/cc-worktree-tests/tests/unit/snippet.test.ts)
- [tests/unit/config.test.ts](/tmp/cc-worktree-tests/tests/unit/config.test.ts)
- [tests/unit/store.test.ts](/tmp/cc-worktree-tests/tests/unit/store.test.ts)
- [tests/unit/stats.test.ts](/tmp/cc-worktree-tests/tests/unit/stats.test.ts)
- [tests/unit/executor.test.ts](/tmp/cc-worktree-tests/tests/unit/executor.test.ts)
- [tests/unit/runtime.test.ts](/tmp/cc-worktree-tests/tests/unit/runtime.test.ts)
- [tests/unit/pretooluse.test.ts](/tmp/cc-worktree-tests/tests/unit/pretooluse.test.ts)
- [tests/integration/server.test.ts](/tmp/cc-worktree-tests/tests/integration/server.test.ts)
- [tests/integration/batch.test.ts](/tmp/cc-worktree-tests/tests/integration/batch.test.ts)
- [tests/integration/fetch.test.ts](/tmp/cc-worktree-tests/tests/integration/fetch.test.ts)

Verification run:

1. `node --import tsx --test tests/unit/*.test.ts`  
Passed after rebuilding `better-sqlite3` for current Node ABI (`npm rebuild better-sqlite3`).

2. `node --import tsx --test tests/integration/*.test.ts`  
Passed after one fixture adjustment in `server.test.ts` to trigger markdown heading chunking.

All requested tests are now implemented and passing.