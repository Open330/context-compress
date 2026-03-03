import type { LanguagePlugin } from "../plugin.js";

export const javascriptPlugin: LanguagePlugin = {
	language: "javascript",
	runtimeCandidates: ["bun", "node"],
	fileExtension: ".js",

	buildCommand(runtime, filePath) {
		return [runtime, filePath];
	},

	wrapWithFileContent(code, filePath) {
		const escaped = JSON.stringify(filePath);
		return `const {readFileSync: __cm_readFileSync} = await import("node:fs");\nconst FILE_CONTENT_PATH = ${escaped};\nconst FILE_CONTENT = __cm_readFileSync(FILE_CONTENT_PATH, "utf-8");\n${code}`;
	},
};
