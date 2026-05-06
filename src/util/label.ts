import type { CompressionLevel } from "../config.js";

/** Shorten labels based on compression level */
export function compactLabel(normal: string, level: CompressionLevel): string {
	if (level === "ultra") {
		return normal
			.replace(/\*\*/g, "")
			.replace(/Use search\(queries: \[\.\.\.]\) to retrieve.*$/gm, "→ search() for more")
			.replace(/Searchable terms: .+$/gm, "");
	}
	if (level === "compact") {
		return normal.replace(
			/Use search\(queries: \[\.\.\.]\) to retrieve full content of any section\./,
			"→ search() for details",
		);
	}
	return normal;
}
