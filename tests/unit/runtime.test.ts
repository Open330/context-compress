import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ALL_PLUGINS, detectRuntimes } from "../../src/runtime/index.js";

const goAvailable = spawnSync("go", ["version"], { stdio: "ignore" }).status === 0;

describe("runtime detection and plugins", () => {
	it("detectRuntimes returns a map with javascript and shell", async () => {
		const runtimes = await detectRuntimes();
		assert.ok(runtimes instanceof Map);
		assert.ok(runtimes.has("javascript"));
		assert.ok(runtimes.has("shell"));
	});

	it("ALL_PLUGINS has exactly 11 plugins", () => {
		assert.strictEqual(ALL_PLUGINS.length, 11);
	});

	it("javascript plugin buildCommand returns [runtime, filePath]", () => {
		const plugin = ALL_PLUGINS.find((p) => p.language === "javascript");
		assert.ok(plugin);
		assert.deepStrictEqual(plugin.buildCommand("node", "/tmp/test.js"), [
			"node",
			"/tmp/test.js",
		]);
	});

	it("go plugin preprocessCode wraps simple code with package main", () => {
		const plugin = ALL_PLUGINS.find((p) => p.language === "go");
		assert.ok(plugin);

		const preprocessed = plugin.preprocessCode?.("fmt.Println(42)");
		assert.ok(preprocessed);
		assert.match(preprocessed, /package main/);
		assert.match(preprocessed, /func main/);
	});

	it("go plugin injects file variables after package imports", () => {
		const plugin = ALL_PLUGINS.find((p) => p.language === "go");
		assert.ok(plugin?.wrapWithFileContent);

		const cases = [
			{
				name: "grouped imports without os",
				code: 'package main\n\nimport (\n\t"fmt"\n\t"strings"\n)\n\nfunc main() { fmt.Print(strings.TrimSpace(FILE_CONTENT)) }\n',
				originalImports: 'import (\n\t"fmt"\n\t"strings"\n)',
				expectedReadFile: "os.ReadFile(FILE_CONTENT_PATH)",
				expectedOsImports: 1,
			},
			{
				name: "existing os import",
				code: 'package main\n\nimport "os"\n\nfunc main() { println(FILE_CONTENT, os.Args[0]) }\n',
				originalImports: 'import "os"',
				expectedReadFile: "os.ReadFile(FILE_CONTENT_PATH)",
				expectedOsImports: 1,
			},
			{
				name: "aliased os import",
				code: 'package main\n\nimport stdos "os"\n\nfunc main() { println(FILE_CONTENT, stdos.Args[0]) }\n',
				originalImports: 'import stdos "os"',
				expectedReadFile: "stdos.ReadFile(FILE_CONTENT_PATH)",
				expectedOsImports: 1,
			},
			{
				name: "no imports",
				code: "package main\n\nfunc main() { println(FILE_CONTENT, FILE_CONTENT_PATH) }\n",
				originalImports: undefined,
				expectedReadFile: "os.ReadFile(FILE_CONTENT_PATH)",
				expectedOsImports: 1,
			},
		] as const;

		for (const testCase of cases) {
			const generated = plugin.wrapWithFileContent(testCase.code, "/tmp/input.txt");
			if (testCase.originalImports) {
				assert.ok(
					generated.includes(testCase.originalImports),
					`${testCase.name}: existing import order changed`,
				);
			}
			assert.strictEqual(
				generated.split('"os"').length - 1,
				testCase.expectedOsImports,
				`${testCase.name}: os should be imported once`,
			);
			assert.ok(
				generated.indexOf(testCase.expectedReadFile) < generated.indexOf("func main"),
				`${testCase.name}: variables should follow imports and precede declarations`,
			);
			assert.match(generated, /var FILE_CONTENT_PATH = "\/tmp\/input\.txt"/);
			assert.match(generated, /var FILE_CONTENT = func\(\) string/);
		}
	});

	it("go plugin never calls ReadFile through a blank-imported os", () => {
		const plugin = ALL_PLUGINS.find((p) => p.language === "go");
		assert.ok(plugin?.wrapWithFileContent);

		// `import _ "os"` imports for side effects only and binds no callable name,
		// so treating `_` as a qualifier generated invalid `_.ReadFile(...)`.
		const cases = [
			'package main\n\nimport _ "os"\n\nfunc main() { println(FILE_CONTENT) }\n',
			'package main\n\nimport (\n\t"fmt"\n\t_ "os"\n)\n\nfunc main() { fmt.Print(FILE_CONTENT) }\n',
		];

		for (const code of cases) {
			const generated = plugin.wrapWithFileContent(code, "/tmp/input.txt");
			assert.doesNotMatch(generated, /\b_\.ReadFile/, "blank identifier is not callable");
			assert.match(generated, /import __ccOs "os"/, "a usable os binding must be added");
			assert.match(generated, /__ccOs\.ReadFile\(FILE_CONTENT_PATH\)/);
			assert.ok(generated.includes('_ "os"'), "the original blank import must be preserved");
			assert.ok(
				generated.indexOf("__ccOs.ReadFile") < generated.indexOf("func main"),
				"variables should precede declarations",
			);
		}
	});

	it("go plugin prefers a real os alias over a blank import of the same package", () => {
		const plugin = ALL_PLUGINS.find((p) => p.language === "go");
		assert.ok(plugin?.wrapWithFileContent);

		const generated = plugin.wrapWithFileContent(
			'package main\n\nimport _ "os"\nimport stdos "os"\n\nfunc main() { println(stdos.Args[0]) }\n',
			"/tmp/input.txt",
		);
		assert.match(generated, /stdos\.ReadFile\(FILE_CONTENT_PATH\)/);
		assert.doesNotMatch(generated, /__ccOs/, "no extra import is needed when one is usable");
	});

	it("go plugin preserves CRLF in package-form generated code", () => {
		const plugin = ALL_PLUGINS.find((p) => p.language === "go");
		assert.ok(plugin?.wrapWithFileContent);

		const code =
			'package main\r\n\r\nimport "fmt"\r\n\r\nfunc main() { fmt.Print(FILE_CONTENT) }\r\n';
		const generated = plugin.wrapWithFileContent(code, "C:\\input.txt");
		assert.doesNotMatch(generated, /(?<!\r)\n/);
		assert.match(generated, /import "fmt"\r\nimport "os"\r\n\r\nvar FILE_CONTENT_PATH/);
	});

	it(
		"go plugin generates executable package-form code",
		{ skip: !goAvailable },
		() => {
			const plugin = ALL_PLUGINS.find((p) => p.language === "go");
			assert.ok(plugin?.wrapWithFileContent);
			const dir = mkdtempSync(join(tmpdir(), "cc-go-runtime-"));
			try {
				const inputPath = join(dir, "input.txt");
				const sourcePath = join(dir, "main.go");
				writeFileSync(inputPath, "injected content");
				writeFileSync(
					sourcePath,
					plugin.wrapWithFileContent(
						'package main\n\nimport "fmt"\n\nfunc main() { fmt.Print(FILE_CONTENT) }\n',
						inputPath,
					),
				);
				const result = spawnSync("go", ["run", sourcePath], { encoding: "utf8" });
				assert.strictEqual(result.status, 0, result.stderr);
				assert.strictEqual(result.stdout, "injected content");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	it("rust plugin compileStep returns execFile-style argument array", () => {
		const plugin = ALL_PLUGINS.find((p) => p.language === "rust");
		assert.ok(plugin);

		const command = plugin.compileStep?.("rustc", "/tmp/test.rs", "/tmp/test-bin");
		assert.deepStrictEqual(command, ["rustc", "/tmp/test.rs", "-o", "/tmp/test-bin"]);
		assert.ok(Array.isArray(command));
	});

	it("php plugin preprocessCode adds php tag when missing", () => {
		const plugin = ALL_PLUGINS.find((p) => p.language === "php");
		assert.ok(plugin);

		const preprocessed = plugin.preprocessCode?.('echo "hello";');
		assert.ok(preprocessed);
		assert.ok(preprocessed.trimStart().startsWith("<?php"));
	});
});
