import { loadConfig, resolveProjectDir } from "./config.js";
import { debug } from "./logger.js";
import { createServer } from "./server.js";

const config = loadConfig(resolveProjectDir());
debug("Starting context-compress server");
debug("Config:", JSON.stringify(config, null, 2));

const server = await createServer(config);
await server.start();
