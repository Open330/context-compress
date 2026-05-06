import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getVersion(fallback = "1.0.0"): string {
	try {
		const pkgPath = resolve(__dirname, "..", "..", "package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		return pkg.version ?? fallback;
	} catch {
		return fallback;
	}
}
