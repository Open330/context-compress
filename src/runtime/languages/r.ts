import type { LanguagePlugin } from "../plugin.js";

export const rPlugin: LanguagePlugin = {
	language: "r",
	runtimeCandidates: ["Rscript", "r"],
	fileExtension: ".R",

	buildCommand(runtime, filePath) {
		return [runtime, filePath];
	},

	wrapWithFileContent(code, filePath) {
		const escaped = JSON.stringify(filePath);
		return `FILE_CONTENT_PATH <- ${escaped}\nFILE_CONTENT <- readLines(FILE_CONTENT_PATH, warn=FALSE)\nFILE_CONTENT <- paste(FILE_CONTENT, collapse="\\n")\n${code}`;
	},
};
