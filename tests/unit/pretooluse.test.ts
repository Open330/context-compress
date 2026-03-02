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
	return execFileSync("node", ["--import", "tsx", hookPath], {
		input: JSON.stringify(payload),
		env: { ...process.env, ...envOverrides },
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
});
