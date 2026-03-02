import type { LanguagePlugin } from "../plugin.js";

export const rubyPlugin: LanguagePlugin = {
	language: "ruby",
	runtimeCandidates: ["ruby"],
	fileExtension: ".rb",

	buildCommand(runtime, filePath) {
		return [runtime, filePath];
	},

	wrapWithFileContent(code, filePath) {
		const escaped = JSON.stringify(filePath);
		return `FILE_CONTENT_PATH = ${escaped}\nFILE_CONTENT = File.read(FILE_CONTENT_PATH)\n${code}`;
	},
};
