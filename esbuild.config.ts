import { build } from "esbuild";

// Bundle server for distribution
await build({
	entryPoints: ["src/index.ts"],
	bundle: true,
	platform: "node",
	target: "node18",
	format: "esm",
	outfile: "dist/server.bundle.mjs",
	external: ["better-sqlite3"],
	sourcemap: true,
	minify: false,
	banner: {
		js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
	},
});

// Bundle pretooluse hook
await build({
	entryPoints: ["src/hooks/pretooluse.ts"],
	bundle: true,
	platform: "node",
	target: "node18",
	format: "esm",
	outfile: "hooks/pretooluse.mjs",
	external: [],
	minify: false,
});

console.log("Build complete.");
