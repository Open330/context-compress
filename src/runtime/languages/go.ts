import type { LanguagePlugin } from "../plugin.js";

interface GoPackageHeader {
	insertAfter: number;
	osQualifier?: string;
	/** `import _ "os"` is present: side-effect only, so it binds no callable name. */
	osBlankImported?: boolean;
}

/**
 * Alias used when `os` is already blank-imported. Importing the path again under
 * an unused name is always legal, and it avoids assuming anything about how the
 * caller's own `os` bindings are spelled.
 */
const OS_ALIAS = "__ccOs";

function lineEnd(code: string, from: number): number {
	const newline = code.indexOf("\n", from);
	return newline === -1 ? code.length : newline + 1;
}

function skipWhitespaceAndComments(code: string, from: number): number {
	let cursor = from;
	while (cursor < code.length) {
		if (/\s/.test(code[cursor])) {
			cursor += 1;
			continue;
		}
		if (code.startsWith("//", cursor)) {
			cursor = lineEnd(code, cursor);
			continue;
		}
		if (code.startsWith("/*", cursor)) {
			const commentEnd = code.indexOf("*/", cursor + 2);
			cursor = commentEnd === -1 ? code.length : commentEnd + 2;
			continue;
		}
		break;
	}
	return cursor;
}

function quotedEnd(code: string, from: number, quote: string): number {
	let cursor = from + 1;
	while (cursor < code.length) {
		if (quote !== "`" && code[cursor] === "\\") {
			cursor += 2;
			continue;
		}
		const char = code[cursor];
		cursor += 1;
		if (char === quote) break;
	}
	return cursor;
}

function blockCommentEnd(code: string, from: number): number {
	const end = code.indexOf("*/", from + 2);
	return end === -1 ? code.length : end + 2;
}

function groupedImportEnd(code: string, openingParen: number): number {
	let cursor = openingParen + 1;
	let depth = 1;
	while (cursor < code.length && depth > 0) {
		const char = code[cursor];
		if (char === '"' || char === "'" || char === "`") {
			cursor = quotedEnd(code, cursor, char);
			continue;
		}
		if (code.startsWith("//", cursor)) {
			cursor = lineEnd(code, cursor);
			continue;
		}
		if (code.startsWith("/*", cursor)) {
			cursor = blockCommentEnd(code, cursor);
			continue;
		}
		if (char === "(") depth += 1;
		if (char === ")") depth -= 1;
		cursor += 1;
	}
	return cursor;
}

function importDeclarationEnd(code: string, importStart: number): number {
	let cursor = importStart + "import".length;
	while (code[cursor] === " " || code[cursor] === "\t") cursor += 1;
	const declarationEnd = code[cursor] === "(" ? groupedImportEnd(code, cursor) : cursor;
	return lineEnd(code, declarationEnd);
}

/**
 * How `os` is bound by one import declaration:
 * `"os"` for a plain import, an alias, `""` for a dot import, `"_"` for a blank
 * (side-effect) import, or `undefined` when the declaration does not import os.
 */
function osQualifier(importDeclaration: string): string | undefined {
	const body = importDeclaration.replace(/^[ \t]*import\b/, "");
	const match = /(?:^|[\r\n;(])[ \t]*(?:([._A-Za-z][A-Za-z0-9_]*)[ \t]+)?["`]os["`]/.exec(body);
	if (!match) return undefined;
	if (match[1] === ".") return "";
	return match[1] ?? "os";
}

/**
 * How the generated code should read the file, given how `os` is already bound.
 *
 * `import` is empty when a usable binding exists; otherwise one is added. A dot
 * import makes ReadFile unqualified, and a blank import needs an aliased import
 * because `_` binds no callable name.
 */
function osAccess(header: GoPackageHeader, newline: string): { import: string; readFile: string } {
	if (header.osQualifier === "") return { import: "", readFile: "ReadFile" };
	if (header.osQualifier !== undefined) {
		return { import: "", readFile: `${header.osQualifier}.ReadFile` };
	}
	const alias = header.osBlankImported ? OS_ALIAS : "";
	return {
		import: `import ${alias ? `${alias} ` : ""}"os"${newline}${newline}`,
		readFile: `${alias || "os"}.ReadFile`,
	};
}

function packageHeader(code: string): GoPackageHeader | undefined {
	const packageDeclaration = /^[ \t]*package\b[^\r\n]*(?:\r\n|\n|$)/m.exec(code);
	if (!packageDeclaration) return undefined;

	let cursor = packageDeclaration.index + packageDeclaration[0].length;
	let insertAfter = cursor;
	let qualifier: string | undefined;
	let blankImported = false;
	while (cursor < code.length) {
		const importStart = skipWhitespaceAndComments(code, cursor);
		if (
			!code.startsWith("import", importStart) ||
			/[A-Za-z0-9_]/.test(code[importStart + "import".length] ?? "")
		) {
			break;
		}
		const importEnd = importDeclarationEnd(code, importStart);
		const found = osQualifier(code.slice(importStart, importEnd));
		// A blank import is not a usable qualifier, so keep scanning for a real
		// one: `import _ "os"` followed by `import osx "os"` should use osx.
		if (found === "_") blankImported = true;
		else qualifier ??= found;
		insertAfter = importEnd;
		cursor = importEnd;
	}

	return { insertAfter, osQualifier: qualifier, osBlankImported: blankImported };
}

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
		const header = packageHeader(code);
		if (header) {
			const newline = code.includes("\r\n") ? "\r\n" : "\n";
			const access = osAccess(header, newline);
			const readFile = access.readFile;
			const osImport = access.import || newline;
			const variables = [
				`var FILE_CONTENT_PATH = ${escaped}`,
				"var FILE_CONTENT = func() string {",
				`\tb, _ := ${readFile}(FILE_CONTENT_PATH)`,
				"\treturn string(b)",
				"}()",
				"",
			].join(newline);
			const suffix = code.slice(header.insertAfter);
			const separator = suffix.startsWith(newline) ? "" : newline;
			return `${code.slice(0, header.insertAfter)}${osImport}${variables}${separator}${suffix}`;
		}
		return `package main\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nfunc main() {\n\tFILE_CONTENT_PATH := ${escaped}\n\tb, _ := os.ReadFile(FILE_CONTENT_PATH)\n\tFILE_CONTENT := string(b)\n\t_ = FILE_CONTENT_PATH\n\t_ = FILE_CONTENT\n\t_ = fmt.Sprintf("")\n${code}\n}`;
	},
};
