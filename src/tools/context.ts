import type { Config } from "../config.js";
import type { SubprocessExecutor } from "../executor.js";
import type { SessionTracker } from "../stats.js";
import type { ContentStore } from "../store.js";
import type { ApplyIntentFilter } from "../util/intent-filter.js";

export interface ToolContext {
	config: Config;
	store: ContentStore;
	tracker: SessionTracker;
	executor: SubprocessExecutor;
	projectDir: string;
	bunDetected: boolean;
	dbFallback: boolean;
	withExecutionLimit: <T>(fn: () => Promise<T>) => Promise<T>;
	applyIntentFilter: ApplyIntentFilter;
}
