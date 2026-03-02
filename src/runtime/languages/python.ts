import type { LanguagePlugin } from "../plugin.js";

export const pythonPlugin: LanguagePlugin = {
	language: "python",
	runtimeCandidates: ["python3", "python"],
	fileExtension: ".py",

	buildCommand(runtime, filePath) {
		return [runtime, filePath];
	},

	wrapWithFileContent(code, filePath) {
		const escaped = JSON.stringify(filePath);
		return `FILE_CONTENT_PATH = ${escaped}\nwith open(FILE_CONTENT_PATH, "r") as _f:\n    FILE_CONTENT = _f.read()\n${code}`;
	},
};
