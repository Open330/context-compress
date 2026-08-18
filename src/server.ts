import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Config } from "./config.js";
import { resolveProjectDir } from "./config.js";
import { SubprocessExecutor } from "./executor.js";
import { configureLogger, debug } from "./logger.js";
import { detectRuntimes, hasBun } from "./runtime/index.js";
import { SessionTracker } from "./stats.js";
import { ContentStore, cleanupStaleDbs } from "./store.js";
import { registerBatchExecuteTool } from "./tools/batch-execute.js";
import type { ToolContext } from "./tools/context.js";
import { registerDiscoverTool } from "./tools/discover.js";
import { registerExecuteTool } from "./tools/execute.js";
import { registerExecuteFileTool } from "./tools/execute-file.js";
import { registerFetchAndIndexTool } from "./tools/fetch-and-index.js";
import { registerIndexTool } from "./tools/index-content.js";
import { registerSearchTool } from "./tools/search.js";
import { registerStatsTool } from "./tools/stats.js";
import { createIntentFilter } from "./util/intent-filter.js";
import { getVersion } from "./util/version.js";

const projectDir = resolveProjectDir();

const MAX_CONCURRENT_EXECUTIONS = 8;
const EXECUTION_LIMIT_ERROR = "Error: too many concurrent executions. Try again shortly.";

export async function createServer(config: Config) {
	// Inject the resolved debug flag so the logger doesn't depend on the config
	// singleton at call time.
	configureLogger(config.debug);

	const version = getVersion();
	debug("Version:", version);

	cleanupStaleDbs();

	const runtimes = detectRuntimes();
	const bunDetected = hasBun(runtimes);
	debug("Runtimes detected:", runtimes.size);

	const executor = new SubprocessExecutor(runtimes, config);
	let store: ContentStore;
	let dbFallback = false;
	try {
		store = new ContentStore({
			persistDb: config.persistDb,
			dbDir: config.dbDir,
			maxIndexedSources: config.maxIndexedSources,
		});
	} catch (e) {
		debug("Failed to create DB, falling back to in-memory:", e);
		store = new ContentStore(":memory:");
		dbFallback = true;
	}

	const cumulativeFile = config.persistDb
		? join(config.dbDir ?? join(projectDir, ".context-compress"), "stats.json")
		: undefined;
	const tracker = new SessionTracker(cumulativeFile);

	let activeExecutions = 0;
	async function withExecutionLimit<T>(fn: () => Promise<T>): Promise<T> {
		if (activeExecutions >= MAX_CONCURRENT_EXECUTIONS) {
			throw new Error(EXECUTION_LIMIT_ERROR);
		}
		activeExecutions++;
		try {
			return await fn();
		} finally {
			activeExecutions--;
		}
	}

	const applyIntentFilter = createIntentFilter({ config, store, tracker });

	const shutdown = () => {
		try {
			tracker.saveCumulative();
		} catch {
			/* ignore */
		}
		try {
			executor.shutdown();
		} catch {
			/* ignore */
		}
		try {
			store.close();
		} catch {
			/* ignore */
		}
	};
	// Registered listeners are tracked so shutdown() can remove them. Leaving them
	// installed meant an embedding process — notably the test runner, which calls
	// createServer twice per file — inherited handlers that call process.exit(1),
	// so one async fault truncated the whole run with no diagnostic.
	const onFatal = (label: string) => (err: unknown) => {
		debug(`${label}:`, err);
		shutdown();
		process.exit(1);
	};
	const listeners: Array<
		[
			NodeJS.Signals | "beforeExit" | "uncaughtException" | "unhandledRejection",
			(...args: never[]) => void,
		]
	> = [
		["SIGINT", shutdown],
		["SIGTERM", shutdown],
		["beforeExit", shutdown],
		["uncaughtException", onFatal("Uncaught exception")],
		["unhandledRejection", onFatal("Unhandled rejection")],
	];
	for (const [event, handler] of listeners) {
		process.on(event, handler as (...args: unknown[]) => void);
	}
	const removeProcessListeners = (): void => {
		for (const [event, handler] of listeners) {
			process.off(event, handler as (...args: unknown[]) => void);
		}
	};

	const server = new McpServer({
		name: "context-compress",
		version,
	});

	const ctx: ToolContext = {
		config,
		store,
		tracker,
		executor,
		projectDir,
		bunDetected,
		dbFallback,
		withExecutionLimit,
		applyIntentFilter,
	};

	registerExecuteTool(server, ctx);
	registerExecuteFileTool(server, ctx);
	registerIndexTool(server, ctx);
	registerSearchTool(server, ctx);
	registerFetchAndIndexTool(server, ctx);
	registerBatchExecuteTool(server, ctx);
	registerStatsTool(server, ctx);
	registerDiscoverTool(server, ctx);

	return {
		/** Exposed so tests can attach an in-memory transport instead of stdio. */
		server,
		/**
		 * Release every resource AND the process-level listeners. An embedder that
		 * creates a server per test would otherwise accumulate handlers that call
		 * process.exit(1) on any later async fault.
		 */
		shutdown() {
			removeProcessListeners();
			shutdown();
		},
		async start() {
			const transport = new StdioServerTransport();
			await server.connect(transport);
			debug("MCP server started on stdio");
		},
	};
}
