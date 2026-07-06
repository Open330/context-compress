import assert from "node:assert";
import { describe, it } from "node:test";
import {
	applyFormatFilter,
	compressJson,
	compressLogs,
	compressNdjson,
	detectFormat,
	maskVariables,
} from "../../src/format-filter.js";

describe("detectFormat", () => {
	it("detects a JSON object", () => {
		assert.equal(detectFormat('{"a": 1, "b": [1,2,3]}'), "json");
	});

	it("detects a JSON array", () => {
		assert.equal(detectFormat("[1, 2, 3]"), "json");
	});

	it("detects NDJSON", () => {
		const nd = ['{"id":1}', '{"id":2}', '{"id":3}', '{"id":4}'].join("\n");
		assert.equal(detectFormat(nd), "ndjson");
	});

	it("detects repetitive logs", () => {
		const logs = Array.from(
			{ length: 40 },
			(_, i) => `2026-07-06T10:00:${String(i).padStart(2, "0")} INFO request handled in ${i}ms`,
		).join("\n");
		assert.equal(detectFormat(logs), "logs");
	});

	it("returns plain for prose", () => {
		assert.equal(detectFormat("just some regular text\nwith a couple lines"), "plain");
	});

	it("returns plain for invalid JSON that looks like JSON", () => {
		assert.equal(detectFormat("{not valid json at all}"), "plain");
	});

	it("returns plain for empty input", () => {
		assert.equal(detectFormat("   \n  "), "plain");
	});
});

describe("maskVariables", () => {
	it("masks timestamps, numbers, and paths to a stable template", () => {
		const a = maskVariables("2026-07-06T10:00:01 INFO served /api/users/42 in 13ms");
		const b = maskVariables("2026-07-06T10:00:99 INFO served /api/users/7 in 250ms");
		assert.equal(a, b, "structurally identical lines must share a template");
	});

	it("masks UUIDs and hashes", () => {
		const m = maskVariables("job 550e8400-e29b-41d4-a716-446655440000 commit a1b2c3d4e5f6");
		assert.ok(m.includes("<UUID>"));
		assert.ok(m.includes("<HASH>"));
	});
});

describe("compressLogs", () => {
	it("folds repeated lines into template + count", () => {
		const logs = Array.from(
			{ length: 50 },
			(_, i) => `2026-07-06T10:00:00 INFO handled req ${i} in ${i}ms`,
		).join("\n");
		const res = compressLogs(logs);
		assert.ok(res.filtered);
		assert.ok(res.output.includes("×"), "should show a repeat count");
		assert.ok(res.output.length < logs.length);
	});

	it("keeps error lines verbatim", () => {
		const lines = [
			...Array.from({ length: 20 }, (_, i) => `INFO ok ${i}`),
			"ERROR connection refused to 10.0.0.5:5432",
			...Array.from({ length: 20 }, (_, i) => `INFO ok ${i + 20}`),
		];
		const res = compressLogs(lines.join("\n"));
		assert.ok(
			res.output.includes("ERROR connection refused to 10.0.0.5:5432"),
			"error line must survive verbatim",
		);
	});
});

describe("compressJson", () => {
	it("minifies pretty-printed JSON losslessly in balanced mode", () => {
		const pretty = JSON.stringify({ a: 1, b: { c: [1, 2, 3] } }, null, 2);
		const res = compressJson(pretty, "balanced");
		assert.ok(res.filtered);
		// Balanced is lossless — must round-trip to the same value.
		assert.deepEqual(JSON.parse(res.output), JSON.parse(pretty));
		assert.ok(res.output.length < pretty.length);
	});

	it("collapses long homogeneous arrays in aggressive mode", () => {
		const big = JSON.stringify({ items: Array.from({ length: 100 }, (_, i) => ({ id: i })) });
		const res = compressJson(big, "aggressive");
		assert.ok(res.filtered);
		assert.ok(res.output.length < big.length);
		assert.ok(res.output.includes("more items"), "should note dropped items");
	});

	it("truncates very long strings in aggressive mode", () => {
		const big = JSON.stringify({ blob: "x".repeat(2000) });
		const res = compressJson(big, "aggressive");
		assert.ok(res.output.includes("chars)"), "should annotate truncated string length");
		assert.ok(res.output.length < big.length);
	});
});

describe("compressNdjson", () => {
	it("folds identical shapes into a schema summary", () => {
		const nd = Array.from({ length: 30 }, (_, i) => JSON.stringify({ id: i, name: `n${i}` })).join(
			"\n",
		);
		const res = compressNdjson(nd, "balanced");
		assert.ok(res.filtered);
		assert.ok(res.output.includes("30 records"));
		assert.ok(res.output.length < nd.length);
	});
});

describe("applyFormatFilter", () => {
	it("is a no-op in conservative mode", () => {
		const pretty = JSON.stringify({ a: 1 }, null, 2);
		const res = applyFormatFilter(pretty, "conservative");
		assert.equal(res.filtered, false);
		assert.equal(res.output, pretty);
	});

	it("does not touch small JSON below the byte floor", () => {
		const small = JSON.stringify({ a: 1 }, null, 2);
		const res = applyFormatFilter(small, "balanced");
		assert.equal(res.filtered, false);
	});

	it("compresses large pretty JSON in balanced mode", () => {
		const pretty = JSON.stringify(
			{ items: Array.from({ length: 100 }, (_, i) => ({ id: i, v: i * 2 })) },
			null,
			2,
		);
		const res = applyFormatFilter(pretty, "balanced");
		assert.ok(res.filtered);
		assert.deepEqual(JSON.parse(res.output), JSON.parse(pretty), "balanced stays lossless");
	});

	it("leaves varied plain prose untouched", () => {
		const prose = Array.from(
			{ length: 100 },
			(_, i) =>
				`Paragraph ${i}: a distinct sentence about ${["apples", "rivers", "compilers", "weather"][i % 4]} and their properties.`,
		).join("\n");
		const res = applyFormatFilter(prose, "aggressive");
		assert.equal(res.filtered, false);
	});
});
