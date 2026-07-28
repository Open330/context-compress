import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const HOOK_BUNDLE = "hooks/pretooluse.mjs";
const HOOK_CHECKSUM = "hooks/pretooluse.sha256";

// `npm run build:hooks` passes this to rebuild only the hook pair.
const hooksOnly = process.argv.includes("--hooks-only");

// Bundle server for distribution
if (!hooksOnly) {
	await build({
		entryPoints: ["src/index.ts"],
		bundle: true,
		platform: "node",
		target: "node22",
		format: "esm",
		outfile: "dist/server.bundle.mjs",
		external: ["better-sqlite3"],
		sourcemap: true,
		minify: false,
		banner: {
			js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
		},
	});
}

// Bundle pretooluse hook
await build({
	entryPoints: ["src/hooks/pretooluse.ts"],
	bundle: true,
	platform: "node",
	target: "node22",
	format: "esm",
	outfile: HOOK_BUNDLE,
	external: [],
	minify: false,
});

// Emit the checksum in the same step that produces the bundle. `doctor` compares
// the two, so generating them separately lets a stale checksum ship alongside a
// fresh bundle and report a bogus integrity failure to every user.
const hookHash = createHash("sha256").update(readFileSync(HOOK_BUNDLE)).digest("hex");
writeFileSync(HOOK_CHECKSUM, `${hookHash}\n`);

console.log(`Build complete. Hook SHA-256: ${hookHash.slice(0, 12)}...`);
