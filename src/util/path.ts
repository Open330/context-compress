import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

interface PathSemantics {
	isAbsolute(path: string): boolean;
	relative(from: string, to: string): string;
	sep: string;
}

const nativePathSemantics: PathSemantics = { isAbsolute, relative, sep };

/**
 * Checks whether two resolved paths have a root/descendant relationship using
 * the supplied platform's path semantics.
 */
export function isPathWithin(
	absPath: string,
	rootDir: string,
	pathSemantics: PathSemantics = nativePathSemantics,
): boolean {
	const relativePath = pathSemantics.relative(rootDir, absPath);
	return (
		relativePath === "" ||
		(!pathSemantics.isAbsolute(relativePath) &&
			relativePath !== ".." &&
			!relativePath.startsWith(`..${pathSemantics.sep}`))
	);
}

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
		return isPathWithin(normalized, realProjectDir);
	} catch {
		const normalized = resolve(absPath);
		const normalizedProject = resolve(projectDir);
		return isPathWithin(normalized, normalizedProject);
	}
}
