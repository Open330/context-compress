import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const hookPath = resolve(__dirname, "../../src/hooks/pretooluse.ts");

function runHook(
	payload: Record<string, unknown>,
	envOverrides: Record<string, string | undefined> = {},
): string {
	// Strip any CONTEXT_COMPRESS_* vars inherited from the developer's shell
	// (e.g. an installed hook exporting CONTEXT_COMPRESS_BIN) so each test
	// controls the hook's environment explicitly and results are deterministic.
	const baseEnv = Object.fromEntries(
		Object.entries(process.env).filter(([k]) => !k.startsWith("CONTEXT_COMPRESS_")),
	);
	return execFileSync("node", ["--import", "tsx", hookPath], {
		input: JSON.stringify(payload),
		env: { ...baseEnv, ...envOverrides },
		encoding: "utf-8",
	});
}

describe("pretooluse hook", () => {
	it("blocks curl command in Bash tool", () => {
		const output = runHook({
			tool_name: "Bash",
			tool_input: { command: "curl https://example.com" },
		});

		const parsed = JSON.parse(output) as {
			hookSpecificOutput: { updatedInput?: { command?: string } };
		};

		const command = parsed.hookSpecificOutput.updatedInput?.command ?? "";
		assert.match(command, /blocked/i);
	});

	it("passes through normal Bash command without output", () => {
		const output = runHook({
			tool_name: "Bash",
			tool_input: { command: "git status" },
		});
		assert.strictEqual(output, "");
	});

	it("denies WebFetch and includes permissionDecision", () => {
		const output = runHook({
			tool_name: "WebFetch",
			tool_input: { url: "https://example.com" },
		});

		const parsed = JSON.parse(output) as {
			hookSpecificOutput: { permissionDecision?: string };
		};

		assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, "deny");
	});

	it("adds additionalContext for Read tool", () => {
		const output = runHook({
			tool_name: "Read",
			tool_input: { file_path: "README.md" },
		});

		const parsed = JSON.parse(output) as {
			hookSpecificOutput: { additionalContext?: string };
		};

		assert.match(parsed.hookSpecificOutput.additionalContext ?? "", /CONTEXT TIP/);
	});

	it("adds additionalContext for Grep tool", () => {
		const output = runHook({
			tool_name: "Grep",
			tool_input: { pattern: "TODO" },
		});

		const parsed = JSON.parse(output) as {
			hookSpecificOutput: { additionalContext?: string };
		};

		assert.match(parsed.hookSpecificOutput.additionalContext ?? "", /CONTEXT TIP/);
	});

	it("does not block curl when CONTEXT_COMPRESS_BLOCK_CURL=0", () => {
		const output = runHook(
			{
				tool_name: "Bash",
				tool_input: { command: "curl https://example.com" },
			},
			{ CONTEXT_COMPRESS_BLOCK_CURL: "0" },
		);

		assert.strictEqual(output, "");
	});

	it("auto-wraps git status when CONTEXT_COMPRESS_FILTER_BASH=1", () => {
		const output = runHook(
			{
				tool_name: "Bash",
				tool_input: { command: "git status --short" },
			},
			{ CONTEXT_COMPRESS_FILTER_BASH: "1", CONTEXT_COMPRESS_MODE: undefined },
		);
		const parsed = JSON.parse(output) as {
			hookSpecificOutput: { updatedInput?: { command?: string } };
		};
		assert.match(
			parsed.hookSpecificOutput.updatedInput?.command ?? "",
			/^context-compress wrap '/,
		);
	});

	it("auto-wraps npm install with custom CONTEXT_COMPRESS_BIN", () => {
		const output = runHook(
			{
				tool_name: "Bash",
				tool_input: { command: "npm install" },
			},
			{
				CONTEXT_COMPRESS_FILTER_BASH: "1",
				CONTEXT_COMPRESS_BIN: "/usr/local/bin/cc",
				CONTEXT_COMPRESS_MODE: undefined,
			},
		);
		const parsed = JSON.parse(output) as {
			hookSpecificOutput: { updatedInput?: { command?: string } };
		};
		assert.match(
			parsed.hookSpecificOutput.updatedInput?.command ?? "",
			/^\/usr\/local\/bin\/cc wrap '/,
		);
	});

	it("does NOT wrap commands containing pipes", () => {
		const output = runHook(
			{
				tool_name: "Bash",
				tool_input: { command: "git log | head -10" },
			},
			{ CONTEXT_COMPRESS_FILTER_BASH: "1" },
		);
		assert.strictEqual(output, "", "piped commands should pass through unchanged");
	});

	it("does NOT wrap commands with output redirection", () => {
		const output = runHook(
			{
				tool_name: "Bash",
				tool_input: { command: "git log > /tmp/log.txt" },
			},
			{ CONTEXT_COMPRESS_FILTER_BASH: "1" },
		);
		assert.strictEqual(output, "", "redirected commands should pass through unchanged");
	});

	it("does NOT wrap multi-statement commands", () => {
		const output = runHook(
			{
				tool_name: "Bash",
				tool_input: { command: "cd /tmp && ls" },
			},
			{ CONTEXT_COMPRESS_FILTER_BASH: "1" },
		);
		assert.strictEqual(output, "", "compound commands should pass through unchanged");
	});

	it("does NOT wrap commands not on the WRAP_TARGETS allowlist", () => {
		const output = runHook(
			{
				tool_name: "Bash",
				tool_input: { command: "echo hello" },
			},
			{ CONTEXT_COMPRESS_FILTER_BASH: "1" },
		);
		assert.strictEqual(output, "");
	});

	it("escapes single quotes in wrapped commands", () => {
		const output = runHook(
			{
				tool_name: "Bash",
				tool_input: { command: "git log --grep='it's broken'" },
			},
			{ CONTEXT_COMPRESS_FILTER_BASH: "1" },
		);
		// Single quotes inside a single-quoted string need '\'' escape.
		const parsed = JSON.parse(output) as {
			hookSpecificOutput: { updatedInput?: { command?: string } };
		};
		const cmd = parsed.hookSpecificOutput.updatedInput?.command ?? "";
		assert.ok(cmd.includes("'\\''"), `expected single-quote escape, got: ${cmd}`);
	});

	it("forwards CONTEXT_COMPRESS_MODE as --mode flag to wrap", () => {
		const output = runHook(
			{
				tool_name: "Bash",
				tool_input: { command: "git log -10" },
			},
			{ CONTEXT_COMPRESS_FILTER_BASH: "1", CONTEXT_COMPRESS_MODE: "aggressive" },
		);
		const parsed = JSON.parse(output) as {
			hookSpecificOutput: { updatedInput?: { command?: string } };
		};
		const cmd = parsed.hookSpecificOutput.updatedInput?.command ?? "";
		assert.match(cmd, /context-compress wrap --mode aggressive '/);
	});

	it("omits --mode flag when CONTEXT_COMPRESS_MODE is unset", () => {
		const output = runHook(
			{
				tool_name: "Bash",
				tool_input: { command: "git log -10" },
			},
			{ CONTEXT_COMPRESS_FILTER_BASH: "1", CONTEXT_COMPRESS_MODE: undefined },
		);
		const parsed = JSON.parse(output) as {
			hookSpecificOutput: { updatedInput?: { command?: string } };
		};
		const cmd = parsed.hookSpecificOutput.updatedInput?.command ?? "";
		assert.ok(!cmd.includes("--mode"), `should not include --mode, got: ${cmd}`);
	});
});
