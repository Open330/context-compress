import type { Language } from "../types.js";

export interface LanguagePlugin {
	/** Language identifier */
	language: Language;

	/** Runtime binary names to try, in preference order */
	runtimeCandidates: string[];

	/**
	 * Build the command array to execute a file.
	 * @param runtime The detected runtime binary (e.g. "bun", "node", "python3")
	 * @param filePath Path to the source file
	 */
	buildCommand(runtime: string, filePath: string): string[];

	/**
	 * Optional code preprocessing (e.g. add package main wrapper for Go).
	 * Return the transformed code, or undefined to use original.
	 */
	preprocessCode?(code: string): string | undefined;

	/**
	 * Wrap user code to inject FILE_CONTENT variable for execute_file.
	 * @param code User code
	 * @param filePath Path to the content file
	 */
	wrapWithFileContent?(code: string, filePath: string): string;

	/**
	 * File extension for temporary source files.
	 */
	fileExtension: string;

	/**
	 * Optional compile step before execution (e.g. rustc).
	 * Returns the command to run the compiled binary.
	 */
	compileStep?(runtime: string, srcPath: string, binPath: string): string[];

	/**
	 * Whether this language needs shell: true for spawning (e.g. .cmd shims on Windows).
	 */
	needsShell?: boolean;
}
