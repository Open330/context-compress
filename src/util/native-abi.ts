import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Explains a native-binding ABI mismatch, or returns null if that is not what
 * failed.
 *
 * better-sqlite3 ships a compiled binding, and the compile happens at install
 * time against whichever Node ran `npm install`. Run the package under a
 * different Node major and dlopen refuses it. This is not exotic: Homebrew's npm
 * and nvm's node coexist on many machines, so `npm i -g` builds against one and
 * the shell's `node` loads the other. Node's own message names two ABI numbers
 * and no package, no path, and no command that would fix it, so the previous
 * behaviour was a twelve-frame stack trace ending in `bindings.js`.
 */
export function describeNativeAbiFailure(error: unknown): string | null {
	const { code, message } = (error ?? {}) as { code?: string; message?: string };
	if (code !== "ERR_DLOPEN_FAILED" || !message?.includes("NODE_MODULE_VERSION")) return null;

	const built = message.match(
		/compiled against a different Node\.js version using\s+NODE_MODULE_VERSION (\d+)/,
	);
	const running = `${process.version} (ABI ${process.versions.modules}) at ${process.execPath}`;
	const installRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

	return [
		"context-compress: the SQLite binding cannot load — it was built for a different Node.",
		"",
		`  running: ${running}`,
		built ? `  binding: built for ABI ${built[1]}` : "  binding: built for another ABI",
		"",
		"This happens when the package is installed by one Node and run by another,",
		"which is the normal outcome of having both Homebrew's npm and nvm on PATH.",
		"Rebuild the binding with the Node that will actually run it:",
		"",
		`  npm rebuild --prefix ${JSON.stringify(installRoot)} better-sqlite3`,
		"",
		"Or reinstall, making sure the same Node is first on PATH both times:",
		"",
		"  npm install -g context-compress",
	].join("\n");
}
