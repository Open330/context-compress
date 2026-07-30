#!/usr/bin/env node
/**
 * PreToolUse hook for context-compress.
 * Redirects data-fetching tools to context-compress MCP tools.
 *
 * Security: NO self-modification of settings.json or installed_plugins.json.
 * Config: Reads CONTEXT_COMPRESS_* env vars for opt-out of blocking behavior.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const TOOL_PREFIX = "context-compress";

// Read config from env
const blockCurl = process.env.CONTEXT_COMPRESS_BLOCK_CURL !== "0";
const blockWebFetch = process.env.CONTEXT_COMPRESS_BLOCK_WEBFETCH !== "0";
const nudgeOnRead = process.env.CONTEXT_COMPRESS_NUDGE_READ !== "0";
const nudgeOnGrep = process.env.CONTEXT_COMPRESS_NUDGE_GREP !== "0";
// Opt-in: when enabled, transparently wrap output-heavy Bash commands with
// `context-compress wrap` so the agent doesn't need to call execute() to
// benefit from compression. Default OFF to avoid surprising existing setups.
const filterBash = process.env.CONTEXT_COMPRESS_FILTER_BASH === "1";
const ccBin = process.env.CONTEXT_COMPRESS_BIN ?? "context-compress";
// Compression mode plumbed through to `context-compress wrap`. Values:
// "conservative" | "balanced" (default) | "aggressive".
const ccMode = process.env.CONTEXT_COMPRESS_MODE;

/**
 * Commands whose output is the primary value and which produce no shell-state
 * side effects (no cd/export/etc.). Safe to redirect through `wrap` because
 * any subshell semantics would be identical.
 */
const WRAP_TARGETS: RegExp[] = [
	/^git\s+(status|log|diff|show|blame|branch|stash\s+list|grep|ls-files)/,
	/^(npm|yarn|pnpm|bun)\s+(install|i|add|test|run\s|update|outdated|audit|list|ls|view|info)/,
	/^cargo\s+(build|test|check|run|clippy|tree|search|metadata)/,
	/^(pytest|jest|mocha|vitest|tap|bats)\b/,
	/^(find|grep|rg|fd|ag|ripgrep)\b/,
	/^ls\s+(-R|-la|-al)/,
	/^docker\s+(build|ps|logs|images|inspect|stats)/,
	/^kubectl\s+(get|describe|logs|top|api-resources)/,
	/^terraform\s+(plan|show|state\s+list|state\s+show|validate)/,
	/^helm\s+(list|status|history|get)/,
	/^(make|gradle|bazel|nx|turbo)\b/,
	/^ps\s+(aux|-ef)/,
	// NOTE: top/htop/watch and follow-mode commands are deliberately absent —
	// they never terminate, and buffered `wrap` would hang until Bash timeout.
	/^(df|du)\b/,
	/^(go|rustc)\s+(test|build|vet|run)/,
];

/**
 * Does a package.json script body start a long-running watcher?
 *
 * `npm test` is on the wrap allowlist, but in a great many projects it maps to
 * a bare `vitest`/`jest --watch`, which never exits. Matching on the command
 * line alone cannot see that, so the script body has to be read.
 */
function isWatcherScript(body: string): boolean {
	const s = body.trim();
	if (/(^|\s)(--watch|--watchAll|--hot|-w)(\s|$)/.test(s)) return true;
	if (/(^|\s)(nodemon|concurrently|watchexec|cargo-watch|tsc-watch)(\s|$)/.test(s)) return true;
	// Tools that watch by default unless given a one-shot subcommand.
	if (/(^|\s)vitest(\s|$)/.test(s) && !/(^|\s)vitest\s+(run|related|bench)\b/.test(s)) return true;
	if (/(^|\s)vite(\s|$)/.test(s) && !/(^|\s)vite\s+(build|preview|optimize)\b/.test(s)) return true;
	if (/(^|\s)(next|nuxt|astro|remix|svelte-kit|expo)\s+(dev|start)\b/.test(s)) return true;
	return false;
}

/** Body of a package.json script in `cwd`, or null if unreadable/absent. */
function packageScriptBody(script: string, cwd: string): string | null {
	try {
		const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8")) as {
			scripts?: Record<string, unknown>;
		};
		const body = pkg.scripts?.[script];
		return typeof body === "string" ? body : null;
	} catch {
		return null;
	}
}

function shouldWrap(cmd: string, cwd: string): boolean {
	const trimmed = cmd.trim();
	// Don't wrap if user is redirecting output to a file/device — they want raw.
	if (/(?:^|\s)(?:>|>>|\d?>&)\s*\S/.test(trimmed)) return false;
	// Don't wrap if command pipes into another tool — already shaping output.
	if (/\|/.test(trimmed)) return false;
	// Don't wrap multi-statement scripts (semicolons, &&, ||) — too hard to
	// reason about state side-effects across statements.
	if (/&&|\|\||;/.test(trimmed)) return false;
	// Never-ending / interactive commands: buffered wrap captures stdout until
	// exit, so these would hang with zero output until the Bash timeout.
	if (/^(top|htop|watch)\b/.test(trimmed)) return false;
	if (/\blogs\b[^|]*\s(-[a-zA-Z]*f|--follow)\b/.test(trimmed)) return false; // docker/kubectl logs -f
	if (/^docker\s+stats\b/.test(trimmed) && !trimmed.includes("--no-stream")) return false;
	if (/\s--?watch\b/.test(trimmed)) return false; // tsc --watch, vitest --watch, etc.
	if (/^cargo\s+watch\b/.test(trimmed)) return false;
	// Bare `vitest` starts watch mode; only the one-shot subcommands are safe.
	if (/^vitest\b/.test(trimmed) && !/^vitest\s+(run|related|bench)\b/.test(trimmed)) return false;
	// Dev servers / watchers via package scripts never terminate either.
	if (/^(npm|yarn|pnpm|bun)\s+(run\s+)?(dev|start|watch|serve)\b/.test(trimmed)) return false;
	// Watcher-ish build-tool targets: `make dev`, `nx serve app`, `turbo watch`.
	if (/^(make|gradle|bazel|nx|turbo)\s+\S*\b(dev|watch|serve|start)\b/.test(trimmed)) return false;
	// Finally, resolve package scripts: the name says nothing about whether the
	// body exits ("npm test" → "vitest" is a watcher).
	const script = trimmed.match(/^(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?([A-Za-z0-9:._-]+)/);
	if (script) {
		const name = script[1] === "t" ? "test" : script[1];
		const body = packageScriptBody(name, cwd);
		if (body && isWatcherScript(body)) return false;
	}
	return WRAP_TARGETS.some((re) => re.test(trimmed));
}

function shellQuote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

let raw = "";
process.stdin.setEncoding("utf-8");
for await (const chunk of process.stdin) raw += chunk;

let input: Record<string, unknown>;
try {
	input = JSON.parse(raw);
} catch {
	process.exit(0);
}
const tool = input.tool_name ?? "";
const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;

/**
 * Emit a PreToolUse hook result and exit.
 *
 * Field names follow the Claude Code PreToolUse contract:
 * `permissionDecision` ("allow" | "deny" | "ask") paired with
 * `permissionDecisionReason`, plus `updatedInput` to rewrite tool arguments
 * and `additionalContext` to append guidance. The legacy top-level
 * `decision` / `reason` fields are deprecated and are not emitted.
 */
function respond(output: Record<string, unknown>): void {
	console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...output } }));
	process.exit(0);
}

// ─── Bash: redirect data-fetching commands ───
if (tool === "Bash") {
	const command = String(toolInput.command ?? "");

	// curl/wget → deny and redirect
	if (blockCurl && /(^|\s|&&|\||;)(curl|wget)\s/i.test(command)) {
		respond({
			permissionDecision: "deny",
			permissionDecisionReason: `${TOOL_PREFIX}: curl/wget blocked. Use mcp__${TOOL_PREFIX}__fetch_and_index(url, source) to fetch URLs, or mcp__${TOOL_PREFIX}__execute(language, code) to run HTTP calls in sandbox. Set CONTEXT_COMPRESS_BLOCK_CURL=0 to disable this.`,
		});
	}

	// inline fetch → deny and redirect
	if (
		blockCurl &&
		(/fetch\s*\(\s*['"](https?:\/\/|http)/i.test(command) ||
			/requests\.(get|post|put)\s*\(/i.test(command) ||
			/http\.(get|request)\s*\(/i.test(command))
	) {
		respond({
			permissionDecision: "deny",
			permissionDecisionReason: `${TOOL_PREFIX}: Inline HTTP blocked. Use mcp__${TOOL_PREFIX}__execute(language, code) to run HTTP calls in sandbox, or mcp__${TOOL_PREFIX}__fetch_and_index(url, source) for web pages.`,
		});
	}

	// Auto-wrap output-heavy commands so their stdout flows through the
	// compression pipeline transparently. Opt-in via CONTEXT_COMPRESS_FILTER_BASH=1.
	// `cwd` comes from the hook payload; fall back to our own for direct invocations.
	const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
	if (filterBash && shouldWrap(command, cwd)) {
		const modeFlag = ccMode ? ` --mode ${ccMode}` : "";
		respond({
			updatedInput: {
				command: `${ccBin} wrap${modeFlag} ${shellQuote(command)}`,
			},
		});
	}

	// Allow all other Bash commands
	process.exit(0);
}

// ─── Read: nudge toward execute_file ───
if (tool === "Read" && nudgeOnRead) {
	respond({
		additionalContext: `CONTEXT TIP: If this file is large (>50 lines), prefer mcp__${TOOL_PREFIX}__execute_file(path, language, code) — processes in sandbox, only stdout enters context.`,
	});
}

// ─── Grep: nudge toward execute ───
if (tool === "Grep" && nudgeOnGrep) {
	respond({
		additionalContext: `CONTEXT TIP: If results may be large, prefer mcp__${TOOL_PREFIX}__execute(language: "shell", code: "grep ...") — runs in sandbox, only stdout enters context.`,
	});
}

// ─── WebFetch: deny + redirect to sandbox ───
if (tool === "WebFetch" && blockWebFetch) {
	const url = String(toolInput.url ?? "");
	respond({
		permissionDecision: "deny",
		permissionDecisionReason: `${TOOL_PREFIX}: WebFetch blocked. Use mcp__${TOOL_PREFIX}__fetch_and_index(url: "${url}", source: "...") to fetch this URL in sandbox. Then use mcp__${TOOL_PREFIX}__search(queries: [...]) to query results.`,
	});
}

// ─── Task/Agent: inject context-compress routing into subagent prompts ───
if (tool === "Task" || tool === "Agent") {
	const subagentType = String(toolInput.subagent_type ?? "");
	const prompt = String(toolInput.prompt ?? "");

	const ROUTING_BLOCK = `

---
CONTEXT WINDOW PROTECTION — USE CONTEXT-COMPRESS MCP TOOLS

Raw Bash/Read/WebFetch output floods your context. You have context-compress tools that keep data in sandbox.

STEP 1 — GATHER: mcp__${TOOL_PREFIX}__batch_execute(commands, queries)
  commands: [{label: "Name", command: "shell cmd"}, ...]
  queries: ["query1", "query2", ...] — put 5-8 queries covering everything you need.
  Runs all commands, indexes output, returns search results. ONE call, no follow-ups.

STEP 2 — FOLLOW-UP: mcp__${TOOL_PREFIX}__search(queries: ["q1", "q2", "q3", ...])
  Pass ALL follow-up questions as queries array. ONE call, not separate calls.

OTHER: execute(language, code) | execute_file(path, language, code) | fetch_and_index(url) + search

FORBIDDEN: Bash for output, Read for files, WebFetch. Bash is ONLY for git/mkdir/rm/mv.

OUTPUT FORMAT — KEEP YOUR FINAL RESPONSE UNDER 500 WORDS:
The parent agent context window is precious. Your full response gets injected into it.

1. ARTIFACTS (PRDs, configs, code files) → Write to FILES, never return as inline text.
   Return only: file path + 1-line description.
2. DETAILED FINDINGS → Index into knowledge base:
   mcp__${TOOL_PREFIX}__index(content: "...", source: "descriptive-label")
   The parent agent shares the SAME knowledge base and can search() your indexed content.
3. YOUR RESPONSE must be a concise summary:
   - What you did (2-3 bullets)
   - File paths created/modified (if any)
   - Source labels you indexed (so parent can search)
   - Key findings in bullet points
   Do NOT return raw data, full file contents, or lengthy explanations.
---`;

	const updatedInput =
		subagentType === "Bash"
			? { ...toolInput, prompt: prompt + ROUTING_BLOCK, subagent_type: "general-purpose" }
			: { ...toolInput, prompt: prompt + ROUTING_BLOCK };

	respond({ updatedInput });
}

// Unknown tool — pass through
process.exit(0);
