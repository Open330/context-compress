# Agentic Benchmark Plan

This benchmark measures context-compress in real agent sessions, not synthetic command output alone.

The claim to test:

> Large tool output should stay searchable outside the conversation, while the agent still solves the same task with less context pressure.

## Why This Exists

`docs/token-reduction-report.md` measures byte and token reduction for common operations. That is necessary, but it does not fully answer whether an agent remains effective across a real coding task.

This benchmark adds the missing layer: run the same task with and without context-compress, isolate each arm, and compare context usage, task success, cost, and time.

## Arms

| Arm | Setup | Purpose |
| --- | --- | --- |
| `baseline` | No context-compress MCP, no hook | Measures normal agent behavior. |
| `mcp-only` | MCP server registered, no PreToolUse hook | Measures explicit tool adoption. |
| `hook-balanced` | MCP plus PreToolUse hook, `CONTEXT_COMPRESS_MODE=balanced` | Default recommended setup. |
| `hook-aggressive` | MCP plus PreToolUse hook, `CONTEXT_COMPRESS_MODE=aggressive` | Maximum compression trade-off. |

Each arm must run in a fresh workspace with isolated agent settings. Do not allow global plugins, global MCP servers, or previous conversation state to leak into the run.

## Task Set

Use tasks that naturally produce large outputs:

1. Diagnose a failing test suite and patch the root cause.
2. Review a multi-commit diff and summarize risky changes.
3. Inspect a large API response and implement one missing field mapping.
4. Analyze a generated Playwright snapshot and fix one selector bug.
5. Audit dependency output and identify one vulnerable or outdated package.
6. Search a large log file and explain the first recurring failure.

Pin every input repository and fixture by commit hash. Preserve every run directory so metrics can be recomputed.

## Metrics

| Metric | How to collect |
| --- | --- |
| Context bytes returned by tools | Sum raw tool payloads in agent logs. |
| Compressed bytes returned | Sum context-compress tool responses. |
| Indexed bytes | Use `stats` output and session DB stats. |
| Task success | Deterministic test, assertion, or scorer per task. |
| Cost/time | Agent runner JSON output when available. |
| Follow-up retrieval quality | Count whether the final answer cites indexed/search results when needed. |

Report raw numbers and relative deltas. Do not only report the best percentage.

## Isolation Rules

- Use a new temp workspace for every `(task, arm, run)` cell.
- Disable user/global plugin sources for the baseline arm.
- Install exactly the intended plugin or MCP config for non-baseline arms.
- Clear persistent context-compress DBs between runs unless the task explicitly tests persistence.
- Keep model, prompt, timeout, and working tree identical across arms.
- Record the exact agent version, model, OS, Node version, and context-compress version.

## Safety Checks

Compression must not hide important failures. Every task needs one deterministic scorer:

- tests pass after the agent patch,
- expected files changed and unrelated files did not,
- security-relevant details are still retrievable with `search`,
- final answer includes the actual root cause, not just a compressed summary.

If an arm uses fewer tokens but fails the scorer, mark it as a failure, not a win.

## Reporting Template

```md
# Agentic benchmark: context-compress on real coding tasks

Date:
Agent:
Model:
context-compress:
Repo/fixture commits:

## Summary

| Arm | Success | Tool bytes in context | Indexed bytes | Cost | Time |
| --- | ---: | ---: | ---: | ---: | ---: |

## Per-task Results

| Task | Arm | Success | Tool bytes | Indexed bytes | Notes |
| --- | --- | ---: | ---: | ---: | --- |

## Failures And Limits

- What failed:
- What this benchmark does not prove:
- Known nondeterminism:
```

## Reproduce

Until this harness is automated, run the benchmark manually with:

```bash
npm run build
context-compress setup --auto
CONTEXT_COMPRESS_MODE=balanced context-compress doctor
```

Then run each task in isolated agent settings and attach the resulting logs plus `context-compress stats` output to the benchmark result.
