import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Returns true when `absPath` resolves inside (or equal to) `projectDir`.
 * Uses realpathSync to defeat symlink-based escapes when the path exists,
 * falling back to a string-prefix check for paths that don't exist yet
 * (e.g. files about to be written).
 */
export function isWithinProject(absPath: string, projectDir: string): boolean {
	try {
		const normalized = realpathSync(resolve(absPath));
		const realProjectDir = realpathSync(projectDir);
		return normalized === realProjectDir || normalized.startsWith(`${realProjectDir}/`);
	} catch {
		const normalized = resolve(absPath);
		const normalizedProject = resolve(projectDir);
		return normalized === normalizedProject || normalized.startsWith(`${normalizedProject}/`);
	}
}
