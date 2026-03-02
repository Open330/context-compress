---
name: context-compress:doctor
description: Run diagnostics to check context-compress health
---

Run the context-compress doctor diagnostic:

```
mcp__context-compress__execute({
  language: "shell",
  code: "node dist/cli/index.js doctor"
})
```

Report the results as-is in markdown format.
