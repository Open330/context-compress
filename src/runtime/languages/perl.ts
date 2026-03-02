import type { LanguagePlugin } from "../plugin.js";

export const perlPlugin: LanguagePlugin = {
	language: "perl",
	runtimeCandidates: ["perl"],
	fileExtension: ".pl",

	buildCommand(runtime, filePath) {
		return [runtime, filePath];
	},

	wrapWithFileContent(code, filePath) {
		const escaped = JSON.stringify(filePath);
		return `my $FILE_CONTENT_PATH = ${escaped};\nopen(my $fh, '<', $FILE_CONTENT_PATH) or die "Cannot open: $!";\nmy $FILE_CONTENT = do { local $/; <$fh> };\nclose($fh);\n${code}`;
	},
};
