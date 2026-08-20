import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { USER_SCOPE_ONLY_KEYS } from "../../src/config.js";

const README = readFileSync(join(process.cwd(), "README.md"), "utf-8");

/**
 * Pinned on purpose. Deriving the expectation from USER_SCOPE_ONLY_KEYS alone
 * makes the suite unable to notice a key being REMOVED from the code: the test
 * for that key disappears with it, the suite stays green with one fewer test,
 * and a project file can set the key again. Verified: deleting "maxOutputBytes"
 * from the code list left 537 pass / 0 fail and let a project file raise the
 * budget to 16,777,216 bytes. A change here should be deliberate.
 */
const EXPECTED_RESTRICTED_KEYS = [
	"passthroughEnvVars",
	"persistDb",
	"dbDir",
	"hardCapBytes",
	"maxOutputBytes",
	"searchWindowMs",
	"searchBlockAfter",
	"searchReduceAfter",
	"maxIndexedSources",
	"compressionLevel",
] as const;

describe("README matches the config trust boundary", () => {
	// The restricted-key list is a security statement: a reader who trusts an
	// under-reported list puts a key in their project file, gets a value that is
	// silently dropped, and believes a limit is in force that is not. The list
	// drifted from four keys to nine once already without the docs following.
	const section = README.slice(README.indexOf("A project file may not set security-relevant keys"));

	it("still restricts every key the trust boundary is known to need", () => {
		assert.deepStrictEqual(
			[...USER_SCOPE_ONLY_KEYS].sort(),
			[...EXPECTED_RESTRICTED_KEYS].sort(),
			"a key was added to or removed from USER_SCOPE_ONLY_KEYS",
		);
	});

	for (const key of EXPECTED_RESTRICTED_KEYS) {
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
		for (const key of EXPECTED_RESTRICTED_KEYS) {
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
