/** CLI entry: print the quality-regression report. Run via `npm run bench:quality`. */
import { formatBenchReport } from "./quality.js";

process.stdout.write(`${formatBenchReport()}\n`);
