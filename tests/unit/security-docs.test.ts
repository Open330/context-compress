import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();

test("security reporting uses the repository's private advisory route", () => {
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
		repository: { url: string };
	};
	const repository = pkg.repository.url.match(/github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/)?.[1];

	assert.ok(repository, "package repository must be a GitHub owner/repository path");

	const security = readFileSync(join(root, "SECURITY.md"), "utf-8");
	const privateAdvisoryUrl = `https://github.com/${repository}/security/advisories/new`;

	assert.ok(
		security.includes(`](${privateAdvisoryUrl})`),
		"SECURITY.md must use the package repository's private vulnerability advisory route",
	);
	assert.doesNotMatch(security, /github\.com\/[^)\s]+\/issues(?:[)#?\s]|$)/);
});
