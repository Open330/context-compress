import type { LanguagePlugin } from "../plugin.js";

export const phpPlugin: LanguagePlugin = {
	language: "php",
	runtimeCandidates: ["php"],
	fileExtension: ".php",

	buildCommand(runtime, filePath) {
		return [runtime, filePath];
	},

	preprocessCode(code) {
		// Add <?php tag if not present
		if (!code.trimStart().startsWith("<?")) {
			return `<?php\n${code}`;
		}
		return undefined;
	},

	wrapWithFileContent(code, filePath) {
		const escaped = JSON.stringify(filePath);
		const preamble = `$FILE_CONTENT_PATH = ${escaped};\n$FILE_CONTENT = file_get_contents($FILE_CONTENT_PATH);\n`;
		if (code.trimStart().startsWith("<?")) {
			return code.replace(/(<\?php\s*)/, `$1\n${preamble}`);
		}
		return `<?php\n${preamble}${code}`;
	},
};
