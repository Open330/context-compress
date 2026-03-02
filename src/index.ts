import { loadConfig } from "./config.js";
import { debug } from "./logger.js";
import { createServer } from "./server.js";

const config = loadConfig(process.env.CLAUDE_PROJECT_DIR);
debug("Starting context-compress server");
debug("Config:", JSON.stringify(config, null, 2));

const server = await createServer(config);
await server.start();
