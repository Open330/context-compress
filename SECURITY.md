# Security

## Trust Model

The MCP server treats the LLM (Claude) as an authorized operator. Code execution via `execute`, `execute_file`, and `batch_execute` tools is intentional and by design — these are the primary mechanisms through which the LLM interacts with the local environment on behalf of the user.

The security boundary exists between the MCP server and **external or untrusted sources** (fetched URLs, indexed content), not between the server and the LLM. The LLM is assumed to be acting within the scope of the user's intent.

## Security Architecture

### Environment Isolation

- A `SAFE_ENV_KEYS` allowlist controls which environment variables are exposed to subprocesses by default.
- Credential passthrough is opt-in via the `passthroughEnvVars` configuration. No secrets are forwarded unless explicitly configured.

### SSRF Protection

- Hostname validation blocks requests to private/internal IP ranges.
- DNS rebinding is prevented through IP pinning: resolved addresses are checked before the connection is established.
- HTTP redirects are blocked to prevent redirect-based SSRF bypasses.

### FTS5 Injection Prevention

- All user-supplied and LLM-supplied search queries are sanitized before being passed to SQLite FTS5 to prevent query injection.

### Path Traversal Protection

- File paths are resolved with `realpathSync` and validated against project boundary checks to prevent reads or writes outside the allowed directory tree.

### Prompt Injection Detection

- Fetched content is scanned with regex-based heuristics to detect prompt injection attempts.
- Detected injections produce advisory warnings. This is a defense-in-depth measure, not a hard enforcement boundary.

### Process Isolation

- Subprocesses are subject to configurable execution timeouts.
- Output is capped to prevent unbounded memory consumption.
- Process group killing ensures child processes are cleaned up on timeout or cancellation.

## Known Limitations

- **No OS-level sandbox.** Subprocesses run with the same user privileges as the MCP server. There is no seccomp, AppArmor, or similar confinement.
- **Unrestricted outbound networking.** Subprocesses can make arbitrary outbound network connections.
- **Regex-based prompt injection detection is bypassable.** Sophisticated or novel injection techniques may evade the current heuristics.
- **No trust-level tagging for indexed content.** Content indexed from untrusted sources (e.g., fetched URLs) is stored and retrieved without metadata distinguishing it from trusted content.

## Hardening Recommendations

For production or high-security deployments, consider the following:

- **Set ulimit/rlimit on subprocesses** to constrain CPU, memory, and file descriptor usage.
- **Use container isolation** (e.g., Docker, gVisor) to sandbox the MCP server and its subprocesses.
- **Enable audit logging** to record tool invocations, executed commands, and fetched URLs.
- **Restrict network egress** from subprocesses using firewall rules or network policies.
- **Review `passthroughEnvVars` carefully** — only forward credentials that are strictly necessary for the task at hand.

## Reporting Vulnerabilities

Please report security issues via [GitHub Issues](https://github.com/nickytonline/context-compress/issues). Include steps to reproduce and any relevant configuration details.
