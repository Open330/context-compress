import type { LanguagePlugin } from "../plugin.js";

export const shellPlugin: LanguagePlugin = {
	language: "shell",
	runtimeCandidates: ["bash", "sh"],
	fileExtension: ".sh",

	buildCommand(runtime, filePath) {
		return [runtime, filePath];
	},

	wrapWithFileContent(code, filePath) {
		// Single-quote the path for shell safety
		const escaped = filePath.replace(/'/g, "'\\''");
		return `FILE_CONTENT_PATH='${escaped}'\nFILE_CONTENT=$(cat '${escaped}')\n${code}`;
	},
};
