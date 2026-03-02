import assert from "node:assert";
import { describe, it } from "node:test";
import { ALL_PLUGINS, detectRuntimes } from "../../src/runtime/index.js";

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
