import { resolve } from "node:path";

/**
 * Shared rules for the hook commands `setup` writes and `uninstall` removes.
 *
 * Both sides must agree on two things, or they corrupt other tools' config:
 * how a path is quoted into a command string, and which commands belong to
 * this package. Keeping them in one module is what makes the two symmetric.
 */

/** Characters that need no quoting in either a POSIX shell or cmd.exe. */
const SAFE_TOKEN = /^[A-Za-z0-9._:\\/+=@-]+$/;

/**
 * Quote a path so it stays exactly one argument.
 *
 * An unquoted `node /Users/me/My Apps/x/pretooluse.mjs` is parsed as two
 * arguments and the hook never runs. A path that is already a single safe token
 * is returned unchanged, so existing configurations do not churn.
 */
export function shellQuotePath(path: string, platform: string = process.platform): string {
	if (SAFE_TOKEN.test(path)) return path;
	if (platform === "win32") {
		// `"` is not a legal character in a Windows path, so this is lossless.
		return `"${path}"`;
	}
	return `'${path.replaceAll("'", "'\\''")}'`;
}

/** Build the command string for a `node`/`tsx` script entry. */
export function buildRunnerCommand(
	runner: "node" | "tsx",
	scriptPath: string,
	platform: string = process.platform,
): string {
	return `${runner} ${shellQuotePath(scriptPath, platform)}`;
}

/** Strip one matching pair of surrounding quotes, undoing shellQuotePath. */
function unquote(value: string): string {
	const quote = value[0];
	if ((quote !== "'" && quote !== '"') || value.at(-1) !== quote || value.length < 2) return value;
	const inner = value.slice(1, -1);
	return quote === "'" ? inner.replaceAll("'\\''", "'") : inner;
}

/** Our hook script, in either the built or the dev-mode layout. */
const HOOK_SCRIPT = /(?:^|[\\/])pretooluse\.(?:mjs|ts)$/;
/** A path that lives inside this package's directory. */
const PACKAGE_SEGMENT = /(?:^|[\\/])context-compress(?:[\\/]|$)/;
/** The installed CLI, however it is spelled by a package manager or plugin. */
const CLI_BASENAME = /(?:^|[\\/])context-compress(?:\.cmd|\.exe|\.ps1)?$/;

/** The script path inside a generated `node <path>` / `tsx <path>` command. */
export function runnerScriptPath(command: string): string | null {
	const match = /^(?:node|tsx)\s+(.+)$/.exec(command.trim());
	return match ? unquote(match[1].trim()) : null;
}

/** The first token of a command, honoring one pair of quotes around it. */
function firstToken(command: string): string {
	const trimmed = command.trim();
	const quoted = /^(['"])(.*?)\1/.exec(trimmed);
	if (quoted) return unquote(quoted[0]);
	return trimmed.split(/\s+/)[0] ?? "";
}

function samePath(left: string, right: string): boolean {
	return resolve(left) === resolve(right);
}

/**
 * Was this hook command written by context-compress?
 *
 * Ownership is deliberately package-specific. Matching only the
 * `pretooluse.mjs` basename claimed any other tool's identically named hook —
 * setup overwrote it and uninstall deleted it. A command is ours when it runs
 * our hook script from inside a `context-compress` directory, when it runs the
 * exact hook path this installation would write, or when it invokes the
 * installed `context-compress` CLI itself.
 *
 * Being too strict merely leaves a stale entry behind for the user to remove;
 * being too loose destroys somebody else's configuration, so this errs strict.
 */
export function isOwnedHookCommand(command: string | undefined, ownHookPath?: string): boolean {
	if (typeof command !== "string" || command.trim() === "") return false;

	if (CLI_BASENAME.test(firstToken(command))) return true;

	const scriptPath = runnerScriptPath(command);
	if (scriptPath === null || !HOOK_SCRIPT.test(scriptPath)) return false;
	if (ownHookPath !== undefined && samePath(scriptPath, ownHookPath)) return true;
	return PACKAGE_SEGMENT.test(scriptPath);
}

/**
 * A `pretooluse`-style hook that is *not* ours.
 *
 * These are never modified or removed. They are reported instead, because the
 * one case we cannot distinguish is a context-compress install that lived at a
 * path without a `context-compress` segment: leaving it alone is correct, but
 * silently adding a second hook beside it would look like a bug.
 */
export function isForeignHookCommand(command: string | undefined, ownHookPath?: string): boolean {
	if (typeof command !== "string") return false;
	const scriptPath = runnerScriptPath(command);
	return (
		scriptPath !== null && HOOK_SCRIPT.test(scriptPath) && !isOwnedHookCommand(command, ownHookPath)
	);
}

/** Environment keys `setup --auto` writes, and therefore the only ones it may remove. */
export const OWNED_ENV_KEYS = ["CONTEXT_COMPRESS_FILTER_BASH", "CONTEXT_COMPRESS_BIN"] as const;

/**
 * Remove only setup-owned env keys, leaving every unrelated variable in place.
 *
 * Returns true when the object is now empty, so the caller can drop the key
 * rather than leave a `"env": {}` stub in a settings file that never had one —
 * uninstall must be the exact inverse of setup, and the same rule already
 * applies to an emptied `mcpServers`.
 */
export function removeOwnedEnv(
	env: Record<string, string> | undefined,
	changes: string[],
): boolean {
	if (!env) return false;
	for (const key of OWNED_ENV_KEYS) {
		if (Object.hasOwn(env, key)) {
			delete env[key];
			changes.push(`Removed ${key}`);
		}
	}
	return Object.keys(env).length === 0;
}
