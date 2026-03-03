import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.js";
import { debug } from "./logger.js";
import type { RuntimeMap } from "./runtime/index.js";
import type { LanguagePlugin } from "./runtime/plugin.js";
import type { ExecFileOptions, ExecOptions, ExecResult, Language } from "./types.js";

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_OUTPUT = 102_400;
const DEFAULT_HARD_CAP = 100 * 1024 * 1024;

/** Safe base environment variables */
const SAFE_ENV_KEYS = [
	"PATH",
	"HOME",
	"USER",
	"SHELL",
	"TMPDIR",
	"TERM",
	"LANG",
	// Windows
	"SYSTEMROOT",
	"COMSPEC",
	"PATHEXT",
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"COMMONPROGRAMFILES",
	"WINDIR",
];

/**
 * Build a safe environment for subprocesses.
 * Security fix: credential passthrough is opt-in via config.passthroughEnvVars.
 */
function buildEnv(config: Config): Record<string, string> {
	const env: Record<string, string> = {};

	// Copy safe base variables
	for (const key of SAFE_ENV_KEYS) {
		if (process.env[key]) {
			env[key] = process.env[key] as string;
		}
	}

	// Deterministic settings
	env.LANG = "en_US.UTF-8";
	env.PYTHONDONTWRITEBYTECODE = "1";
	env.PYTHONUNBUFFERED = "1";
	env.NO_COLOR = "1";

	// Opt-in passthrough (security fix: default is empty)
	for (const key of config.passthroughEnvVars) {
		if (process.env[key]) {
			env[key] = process.env[key] as string;
		}
	}

	return env;
}

/** Kill process and its children */
function killProcessTree(pid: number): void {
	try {
		if (process.platform === "win32") {
			execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)]);
		} else {
			// Kill process group
			process.kill(-pid, "SIGKILL");
		}
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Process already exited
		}
	}
}

/**
 * Smart truncation: keep 60% head + 40% tail, snapping to line boundaries.
 */
function smartTruncate(output: string, maxBytes: number): string {
	if (Buffer.byteLength(output) <= maxBytes) return output;

	const lines = output.split("\n");
	const headRatio = 0.6;
	const headTarget = Math.floor(maxBytes * headRatio);
	const tailTarget = maxBytes - headTarget;

	// Collect head lines
	let headBytes = 0;
	let headEnd = 0;
	for (let i = 0; i < lines.length; i++) {
		const lineBytes = Buffer.byteLength(lines[i]) + 1; // +1 for newline
		if (headBytes + lineBytes > headTarget) break;
		headBytes += lineBytes;
		headEnd = i + 1;
	}

	// Collect tail lines
	let tailBytes = 0;
	let tailStart = lines.length;
	for (let i = lines.length - 1; i >= headEnd; i--) {
		const lineBytes = Buffer.byteLength(lines[i]) + 1;
		if (tailBytes + lineBytes > tailTarget) break;
		tailBytes += lineBytes;
		tailStart = i;
	}

	const headLines = lines.slice(0, headEnd);
	const tailLines = lines.slice(tailStart);
	const truncatedLines = lines.length - headEnd - (lines.length - tailStart);
	const truncatedBytes = Buffer.byteLength(output) - headBytes - tailBytes;

	const separator = `\n... [${truncatedLines} lines / ${formatBytes(truncatedBytes)} truncated — showing first ${headEnd} + last ${lines.length - tailStart} lines] ...\n`;

	return headLines.join("\n") + separator + tailLines.join("\n");
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export class SubprocessExecutor {
	private runtimes: RuntimeMap;
	private config: Config;
	private env: Record<string, string>;

	constructor(runtimes: RuntimeMap, config: Config) {
		this.runtimes = runtimes;
		this.config = config;
		this.env = buildEnv(config);
	}

	/**
	 * Execute code in a subprocess.
	 */
	async execute(opts: ExecOptions): Promise<ExecResult> {
		const entry = this.runtimes.get(opts.language);
		if (!entry) {
			return {
				stdout: "",
				stderr: `Language "${opts.language}" is not available. No runtime detected.`,
				exitCode: 1,
				truncated: false,
				killed: false,
			};
		}

		const { plugin, runtime } = entry;
		const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
		const maxOutput = opts.maxOutputBytes ?? this.config.maxOutputBytes;
		const tmpDir = this.createTempDir();

		let code = opts.code;

		// Apply preprocessing (e.g. Go package wrapper, PHP tag, Rust main)
		const preprocessed = plugin.preprocessCode?.(code);
		if (preprocessed !== undefined) {
			code = preprocessed;
		}

		// Add network tracking for JS/TS
		if (opts.language === "javascript" || opts.language === "typescript") {
			code = wrapWithNetworkTracking(code);
		}

		const srcPath = join(tmpDir, `main${plugin.fileExtension}`);
		writeFileSync(srcPath, code);

		try {
			// Handle compiled languages (Rust)
			if (plugin.compileStep) {
				const binPath = join(tmpDir, process.platform === "win32" ? "main.exe" : "main");
				const compileCmd = plugin.compileStep(runtime, srcPath, binPath);
				try {
					// Security fix: execFileSync with array args, no shell injection
					execFileSync(compileCmd[0], compileCmd.slice(1), {
						timeout: timeout,
						cwd: tmpDir,
						env: this.env,
					});
				} catch (e: unknown) {
					const err = e as { stderr?: Buffer; message?: string };
					return {
						stdout: "",
						stderr: err.stderr?.toString() ?? err.message ?? "Compilation failed",
						exitCode: 1,
						truncated: false,
						killed: false,
					};
				}
				return await this.spawnAndCapture(binPath, [], tmpDir, timeout, maxOutput);
			}

			const cmd = plugin.buildCommand(runtime, srcPath);
			return await this.spawnAndCapture(
				cmd[0],
				cmd.slice(1),
				tmpDir,
				timeout,
				maxOutput,
				plugin.needsShell,
			);
		} finally {
			// Defer cleanup slightly so runtime (especially Bun) fully exits
			setTimeout(() => this.cleanupTempDir(tmpDir), 100);
		}
	}

	/**
	 * Execute code with FILE_CONTENT injected.
	 */
	async executeFile(opts: ExecFileOptions): Promise<ExecResult> {
		const entry = this.runtimes.get(opts.language);
		if (!entry) {
			return {
				stdout: "",
				stderr: `Language "${opts.language}" is not available.`,
				exitCode: 1,
				truncated: false,
				killed: false,
			};
		}

		const { plugin } = entry;
		let code = opts.code;

		if (plugin.wrapWithFileContent) {
			code = plugin.wrapWithFileContent(code, opts.filePath);
		}

		return this.execute({ ...opts, code });
	}

	private spawnAndCapture(
		cmd: string,
		args: string[],
		cwd: string,
		timeout: number,
		maxOutput: number,
		useShell?: boolean,
	): Promise<ExecResult> {
		return new Promise((resolve) => {
			const hardCap = this.config.hardCapBytes;
			const stdoutChunks: Buffer[] = [];
			const stderrChunks: Buffer[] = [];
			let totalBytes = 0;
			let killed = false;
			let networkBytes: number | undefined;
			let resolved = false;

			const proc = spawn(cmd, args, {
				cwd,
				env: { ...this.env, TMPDIR: cwd },
				stdio: ["ignore", "pipe", "pipe"],
				timeout,
				shell: useShell,
				detached: process.platform !== "win32",
			});

			proc.stdout?.on("data", (chunk: Buffer) => {
				totalBytes += chunk.length;
				if (totalBytes > hardCap) {
					killed = true;
					if (proc.pid) killProcessTree(proc.pid);
					return;
				}
				stdoutChunks.push(chunk);
			});

			proc.stderr?.on("data", (chunk: Buffer) => {
				totalBytes += chunk.length;
				if (totalBytes > hardCap) {
					killed = true;
					if (proc.pid) killProcessTree(proc.pid);
					return;
				}
				stderrChunks.push(chunk);
			});

			proc.on("error", (err) => {
				debug("Process error:", err.message);
				if (!resolved) {
					resolved = true;
					resolve({
						stdout: "",
						stderr: err.message,
						exitCode: 1,
						truncated: false,
						killed: false,
					});
				}
			});

			proc.on("close", (code) => {
				if (resolved) return;
				resolved = true;
				let stdout = Buffer.concat(stdoutChunks).toString("utf-8");
				let stderr = Buffer.concat(stderrChunks).toString("utf-8");

				// Extract network bytes from JS/TS stderr marker
				const netMatch = stderr.match(/__CM_NET__:(\d+)/);
				if (netMatch) {
					networkBytes = Number.parseInt(netMatch[1], 10);
					stderr = stderr.replace(/__CM_NET__:\d+\n?/, "");
				}

				if (killed) {
					stdout += `\n[output capped at ${formatBytes(hardCap)} — process killed]`;
				}

				const truncated = Buffer.byteLength(stdout) > maxOutput;
				if (truncated) {
					stdout = smartTruncate(stdout, maxOutput);
				}

				resolve({
					stdout,
					stderr,
					exitCode: code,
					truncated,
					killed,
					networkBytes,
				});
			});
		});
	}

	private createTempDir(): string {
		const base = join(tmpdir(), "context-compress");
		mkdirSync(base, { recursive: true });
		return mkdtempSync(join(base, "exec-"));
	}

	private cleanupTempDir(dir: string): void {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch (e) {
			debug("Failed to cleanup temp dir:", dir, e);
		}
	}
}

/**
 * Wrap JS/TS code with fetch interceptor for network tracking.
 */
function wrapWithNetworkTracking(code: string): string {
	const preamble =
		"let __cm_net=0;const __cm_f=globalThis.fetch;if(__cm_f){globalThis.fetch=async(...a)=>{const r=await __cm_f(...a);try{const cl=r.headers.get('content-length');if(cl){__cm_net+=parseInt(cl,10)}else{const b=await r.clone().arrayBuffer();__cm_net+=b.byteLength}}catch{}return r};}";
	const epilogue = `\nprocess.stderr.write('__CM_NET__:'+__cm_net+'\\n');`;

	// Wrap in async IIFE
	return `${preamble}\nasync function __cm_main(){${code}}\n__cm_main().then(()=>{${epilogue}}).catch(e=>{console.error(e);${epilogue}process.exit(1)});`;
}
