import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
			hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string };
		};

		// Denying is cheaper than rewriting the command to `echo ...`: the agent
		// gets the redirect immediately instead of paying for a shell round-trip.
		assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, "deny");
		assert.match(parsed.hookSpecificOutput.permissionDecisionReason ?? "", /blocked/i);
		assert.match(parsed.hookSpecificOutput.permissionDecisionReason ?? "", /fetch_and_index/);
	});

	it("blocks inline HTTP calls in Bash tool", () => {
		const output = runHook({
			tool_name: "Bash",
			tool_input: { command: "python -c \"import requests; requests.get('https://x.com')\"" },
		});

		const parsed = JSON.parse(output) as {
			hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string };
		};

		assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, "deny");
		assert.match(parsed.hookSpecificOutput.permissionDecisionReason ?? "", /Inline HTTP blocked/);
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

	it("carries the deny reason in permissionDecisionReason, not legacy fields", () => {
		// Claude Code reads `hookSpecificOutput.permissionDecisionReason`. A payload
		// using the legacy top-level `decision`/`reason` pair — or a bare `reason`
		// inside hookSpecificOutput — silently drops the redirect instructions.
		const output = runHook({
			tool_name: "WebFetch",
			tool_input: { url: "https://example.com/docs" },
		});

		const parsed = JSON.parse(output) as {
			decision?: string;
			reason?: string;
			hookSpecificOutput: {
				hookEventName?: string;
				permissionDecisionReason?: string;
				reason?: string;
			};
		};

		assert.strictEqual(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
		assert.match(
			parsed.hookSpecificOutput.permissionDecisionReason ?? "",
			/fetch_and_index\(url: "https:\/\/example\.com\/docs"/,
		);
		assert.strictEqual(parsed.hookSpecificOutput.reason, undefined);
		assert.strictEqual(parsed.decision, undefined);
		assert.strictEqual(parsed.reason, undefined);
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

	it("does not read hook controls from .context-compress.json", () => {
		const dir = mkdtempSync(join(tmpdir(), "cc-hook-config-"));
		try {
			writeFileSync(join(dir, ".context-compress.json"), JSON.stringify({ blockCurl: false }));
			const output = runHook({
				tool_name: "Bash",
				tool_input: { command: "curl https://example.com" },
				cwd: dir,
			});
			const parsed = JSON.parse(output) as {
				hookSpecificOutput: { permissionDecision?: string };
			};
			assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, "deny");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
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
		assert.match(parsed.hookSpecificOutput.updatedInput?.command ?? "", /^context-compress wrap '/);
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

	it("supports node/tsx script bins and keeps path spaces and quotes inert", () => {
		const cases = [
			{
				bin: "node /opt/Context Tools/cli/index.js",
				expected: "node '/opt/Context Tools/cli/index.js' wrap 'git status --short'",
			},
			{
				bin: "tsx /opt/Context Tools/owner's cli/index.ts",
				expected: "tsx '/opt/Context Tools/owner'\\''s cli/index.ts' wrap 'git status --short'",
			},
		];

		for (const { bin, expected } of cases) {
			const output = runHook(
				{ tool_name: "Bash", tool_input: { command: "git status --short" } },
				{
					CONTEXT_COMPRESS_FILTER_BASH: "1",
					CONTEXT_COMPRESS_BIN: bin,
					CONTEXT_COMPRESS_MODE: undefined,
				},
			);
			const parsed = JSON.parse(output) as {
				hookSpecificOutput: { updatedInput?: { command?: string } };
			};
			assert.strictEqual(parsed.hookSpecificOutput.updatedInput?.command, expected);
		}
	});

	it("supports a quoted absolute executable path as one inert token", () => {
		const output = runHook(
			{ tool_name: "Bash", tool_input: { command: "git status" } },
			{
				CONTEXT_COMPRESS_FILTER_BASH: "1",
				CONTEXT_COMPRESS_BIN: '"/opt/Context Tools/context-compress"',
				CONTEXT_COMPRESS_MODE: "balanced",
			},
		);
		const parsed = JSON.parse(output) as {
			hookSpecificOutput: { updatedInput?: { command?: string } };
		};
		assert.strictEqual(
			parsed.hookSpecificOutput.updatedInput?.command,
			"'/opt/Context Tools/context-compress' wrap --mode balanced 'git status'",
		);
	});

	it("fails open without rewriting unsafe or unsupported bin configuration", () => {
		for (const bin of [
			"context-compress; touch /tmp/cc-owned",
			"context-compress\n touch /tmp/cc-owned",
			"context-compress$(touch /tmp/cc-owned)",
			"context-compress`touch /tmp/cc-owned`",
			"node --eval",
			'node "/tmp/cli.js" --require "extra.js"',
			"relative/path/context-compress",
		]) {
			const output = runHook(
				{ tool_name: "Bash", tool_input: { command: "git status" } },
				{ CONTEXT_COMPRESS_FILTER_BASH: "1", CONTEXT_COMPRESS_BIN: bin },
			);
			assert.strictEqual(output, "", `unsafe or unsupported bin must pass through: ${bin}`);
		}
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

	it("does NOT wrap never-ending commands (they would hang under buffered wrap)", () => {
		const streaming = [
			"top",
			"htop",
			"watch ls",
			"kubectl logs -f my-pod",
			"docker logs --follow app",
			"docker stats",
			"npm run dev",
			"npm start",
			"cargo watch",
		];
		for (const command of streaming) {
			const output = runHook(
				{ tool_name: "Bash", tool_input: { command } },
				{ CONTEXT_COMPRESS_FILTER_BASH: "1" },
			);
			assert.strictEqual(output, "", `"${command}" must not be wrapped`);
		}
	});

	it("still wraps one-shot commands similar to streaming ones", () => {
		for (const command of [
			"kubectl logs my-pod",
			"docker stats --no-stream",
			"docker logs --tail 50 app",
		]) {
			const output = runHook(
				{ tool_name: "Bash", tool_input: { command } },
				{ CONTEXT_COMPRESS_FILTER_BASH: "1", CONTEXT_COMPRESS_MODE: undefined },
			);
			const parsed = JSON.parse(output) as {
				hookSpecificOutput: { updatedInput?: { command?: string } };
			};
			assert.match(
				parsed.hookSpecificOutput.updatedInput?.command ?? "",
				/wrap '/,
				`"${command}" should be wrapped`,
			);
		}
	});

	it("does NOT wrap a package script whose body is a watcher", () => {
		// `npm test` is on the allowlist, but here it maps to a bare `vitest`,
		// which never exits — the hook has to read package.json to know that.
		const dir = mkdtempSync(join(tmpdir(), "cc-hook-watch-"));
		try {
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({ scripts: { test: "vitest", dev: "next dev", ci: "vitest run" } }),
			);
			for (const command of ["npm test", "npm run dev", "pnpm run test"]) {
				const output = runHook(
					{ tool_name: "Bash", tool_input: { command }, cwd: dir },
					{ CONTEXT_COMPRESS_FILTER_BASH: "1" },
				);
				assert.strictEqual(output, "", `"${command}" must not be wrapped`);
			}
			// A one-shot script in the same project still gets wrapped.
			const wrapped = runHook(
				{ tool_name: "Bash", tool_input: { command: "npm run ci" }, cwd: dir },
				{ CONTEXT_COMPRESS_FILTER_BASH: "1" },
			);
			assert.match(wrapped, /wrap /, "npm run ci → `vitest run` exits, so wrap it");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does NOT wrap watcher-style build-tool targets", () => {
		for (const command of ["make dev", "nx serve my-app", "turbo watch"]) {
			const output = runHook(
				{ tool_name: "Bash", tool_input: { command } },
				{ CONTEXT_COMPRESS_FILTER_BASH: "1" },
			);
			assert.strictEqual(output, "", `"${command}" must not be wrapped`);
		}
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

	it("forwards only supported CONTEXT_COMPRESS_MODE values as --mode flags", () => {
		for (const mode of ["conservative", "balanced", "aggressive", "auto"]) {
			const output = runHook(
				{
					tool_name: "Bash",
					tool_input: { command: "git log -10" },
				},
				{ CONTEXT_COMPRESS_FILTER_BASH: "1", CONTEXT_COMPRESS_MODE: mode },
			);
			const parsed = JSON.parse(output) as {
				hookSpecificOutput: { updatedInput?: { command?: string } };
			};
			const cmd = parsed.hookSpecificOutput.updatedInput?.command ?? "";
			assert.match(cmd, new RegExp(`context-compress wrap --mode ${mode} `));
		}
	});

	it("fails open without rewriting invalid or injectable CONTEXT_COMPRESS_MODE values", () => {
		for (const mode of [
			"",
			"balanced ",
			"balanced; touch /tmp/cc-owned",
			"balanced\n touch /tmp/cc-owned",
			"$(touch /tmp/cc-owned)",
			"`touch /tmp/cc-owned`",
		]) {
			const output = runHook(
				{ tool_name: "Bash", tool_input: { command: "git status" } },
				{ CONTEXT_COMPRESS_FILTER_BASH: "1", CONTEXT_COMPRESS_MODE: mode },
			);
			assert.strictEqual(output, "", `invalid mode must pass through: ${mode}`);
		}
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
