import type { LanguagePlugin } from "../plugin.js";

export const elixirPlugin: LanguagePlugin = {
	language: "elixir",
	runtimeCandidates: ["elixir"],
	fileExtension: ".exs",

	buildCommand(runtime, filePath) {
		return [runtime, filePath];
	},

	wrapWithFileContent(code, filePath) {
		const escaped = JSON.stringify(filePath);
		return `file_content_path = ${escaped}\nfile_content = File.read!(file_content_path)\n${code}`;
	},

	// elixir may be a .cmd shim on Windows
	needsShell: process.platform === "win32",
};
