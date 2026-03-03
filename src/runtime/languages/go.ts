import type { LanguagePlugin } from "../plugin.js";

export const goPlugin: LanguagePlugin = {
	language: "go",
	runtimeCandidates: ["go"],
	fileExtension: ".go",

	buildCommand(runtime, filePath) {
		return [runtime, "run", filePath];
	},

	preprocessCode(code) {
		// Wrap in package main if not already present
		if (!/^package\s/m.test(code)) {
			const hasImport = /^import\s/m.test(code);
			if (hasImport) {
				return `package main\n\n${code}`;
			}
			return `package main\n\nimport "fmt"\n\nfunc main() {\n${code}\n_ = fmt.Sprintf("")\n}`;
		}
		return undefined;
	},

	wrapWithFileContent(code, filePath) {
		const escaped = JSON.stringify(filePath);
		const hasPackage = /^package\s/m.test(code);
		if (hasPackage) {
			// Insert after package declaration
			return code.replace(
				/(package\s+\w+\n)/,
				`$1\nimport "os"\n\nvar FILE_CONTENT_PATH = ${escaped}\nvar _ = func() string { b, _ := os.ReadFile(FILE_CONTENT_PATH); return string(b) }()\n`,
			);
		}
		return `package main\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nfunc main() {\n\tFILE_CONTENT_PATH := ${escaped}\n\tb, _ := os.ReadFile(FILE_CONTENT_PATH)\n\tFILE_CONTENT := string(b)\n\t_ = FILE_CONTENT_PATH\n\t_ = FILE_CONTENT\n\t_ = fmt.Sprintf("")\n${code}\n}`;
	},
};
