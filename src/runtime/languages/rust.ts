import type { LanguagePlugin } from "../plugin.js";

export const rustPlugin: LanguagePlugin = {
	language: "rust",
	runtimeCandidates: ["rustc"],
	fileExtension: ".rs",

	buildCommand(_runtime, filePath) {
		// For Rust, the binary path is used after compilation
		return [filePath];
	},

	// Security fix: use execFileSync array form instead of shell string
	compileStep(runtime, srcPath, binPath) {
		return [runtime, srcPath, "-o", binPath];
	},

	preprocessCode(code) {
		if (!code.includes("fn main")) {
			return `fn main() {\n${code}\n}`;
		}
		return undefined;
	},

	wrapWithFileContent(code, filePath) {
		const escaped = JSON.stringify(filePath);
		const preamble = `use std::fs;\nlet file_content_path = ${escaped};\nlet file_content = fs::read_to_string(file_content_path).unwrap();\n`;
		if (code.includes("fn main")) {
			return code.replace(
				/fn main\s*\(\s*\)\s*\{/,
				`fn main() {\n${preamble}`,
			);
		}
		return `fn main() {\n${preamble}${code}\n}`;
	},
};
