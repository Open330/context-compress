#!/usr/bin/env node
/**
 * PreToolUse hook for context-compress.
 * Redirects data-fetching tools to context-compress MCP tools.
 *
 * Security: NO self-modification of settings.json or installed_plugins.json.
 * Config: Reads CONTEXT_COMPRESS_* env vars for opt-out of blocking behavior.
 */

const TOOL_PREFIX = "context-compress";

// Read config from env
const blockCurl = process.env.CONTEXT_COMPRESS_BLOCK_CURL !== "0";
const blockWebFetch = process.env.CONTEXT_COMPRESS_BLOCK_WEBFETCH !== "0";
const nudgeOnRead = process.env.CONTEXT_COMPRESS_NUDGE_READ !== "0";
const nudgeOnGrep = process.env.CONTEXT_COMPRESS_NUDGE_GREP !== "0";

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

function respond(output: Record<string, unknown>): void {
	console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...output } }));
	process.exit(0);
}

// ─── Bash: redirect data-fetching commands ───
if (tool === "Bash") {
	const command = String(toolInput.command ?? "");

	// curl/wget → block and redirect
	if (blockCurl && /(^|\s|&&|\||\;)(curl|wget)\s/i.test(command)) {
		respond({
			updatedInput: {
				command: `echo "${TOOL_PREFIX}: curl/wget blocked. Use mcp__${TOOL_PREFIX}__fetch_and_index(url, source) to fetch URLs, or mcp__${TOOL_PREFIX}__execute(language, code) to run HTTP calls in sandbox. Set CONTEXT_COMPRESS_BLOCK_CURL=0 to disable this."`,
			},
		});
	}

	// inline fetch → block and redirect
	if (
		blockCurl &&
		(/fetch\s*\(\s*['"](https?:\/\/|http)/i.test(command) ||
			/requests\.(get|post|put)\s*\(/i.test(command) ||
			/http\.(get|request)\s*\(/i.test(command))
	) {
		respond({
			updatedInput: {
				command: `echo "${TOOL_PREFIX}: Inline HTTP blocked. Use mcp__${TOOL_PREFIX}__execute(language, code) to run HTTP calls in sandbox, or mcp__${TOOL_PREFIX}__fetch_and_index(url, source) for web pages."`,
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
		reason: `${TOOL_PREFIX}: WebFetch blocked. Use mcp__${TOOL_PREFIX}__fetch_and_index(url: "${url}", source: "...") to fetch this URL in sandbox. Then use mcp__${TOOL_PREFIX}__search(queries: [...]) to query results.`,
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
