import type { LanguagePlugin } from "../plugin.js";

export const typescriptPlugin: LanguagePlugin = {
	language: "typescript",
	runtimeCandidates: ["bun", "tsx", "ts-node"],
	fileExtension: ".ts",

	buildCommand(runtime, filePath) {
		return [runtime, filePath];
	},

	wrapWithFileContent(code, filePath) {
		const escaped = JSON.stringify(filePath);
		return `const {readFileSync: __cm_readFileSync} = await import("node:fs");\nconst FILE_CONTENT_PATH = ${escaped};\nconst FILE_CONTENT = __cm_readFileSync(FILE_CONTENT_PATH, "utf-8");\n${code}`;
	},

	// tsx and ts-node may be .cmd shims on Windows
	needsShell: process.platform === "win32",
};
