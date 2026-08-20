import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { USER_SCOPE_ONLY_KEYS } from "../../src/config.js";

const README = readFileSync(join(process.cwd(), "README.md"), "utf-8");

describe("README matches the config trust boundary", () => {
	// The restricted-key list is a security statement: a reader who trusts an
	// under-reported list puts a key in their project file, gets a value that is
	// silently dropped, and believes a limit is in force that is not. The list
	// drifted from four keys to nine once already without the docs following.
	const section = README.slice(README.indexOf("A project file may not set security-relevant keys"));

	for (const key of USER_SCOPE_ONLY_KEYS) {
		it(`documents that a project file cannot set ${key}`, () => {
			assert.ok(section.includes(`\`${key}\``), `README omits the restricted key ${key}`);
		});
	}

	it("does not tell the reader to put a restricted key in a project file", () => {
		// The example block sat under "Create .context-compress.json in your project
		// root or home directory" and set two keys that a project file cannot set.
		const start = README.indexOf("### Config File");
		const projectExample = README.slice(
			README.indexOf("A project file accepts everything except", start),
			README.indexOf("A project file may not set security-relevant keys", start),
		);
		assert.ok(projectExample.length > 0, "the project-scope example is missing");
		for (const key of USER_SCOPE_ONLY_KEYS) {
			assert.ok(
				!projectExample.includes(`"${key}"`),
				`the project-scope example sets ${key}, which is ignored`,
			);
		}
	});

	it("states the restriction is enforced with a warning, not silently", () => {
		assert.match(section, /ignored with a warning on stderr/);
	});
});
