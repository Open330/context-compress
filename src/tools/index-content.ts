import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isWithinProject } from "../util/path.js";
import type { ToolContext } from "./context.js";

export function registerIndexTool(server: McpServer, ctx: ToolContext): void {
	const { store, tracker, projectDir } = ctx;

	server.tool(
		"index",
		"Index documentation or knowledge content into a searchable BM25 knowledge base. Chunks markdown by headings (keeping code blocks intact) and stores in ephemeral FTS5 database. The full content does NOT stay in context — only a brief summary is returned.\n\nWHEN TO USE:\n- Documentation (API docs, framework guides, code examples)\n- README files, migration guides, changelog entries\n- Any content with code examples you may need to reference precisely\n\nAfter indexing, use 'search' to retrieve specific sections on-demand.",
		{
			content: z
				.string()
				.optional()
				.describe("Raw text/markdown to index. Provide this OR path, not both."),
			path: z
				.string()
				.optional()
				.describe("File path to read and index (content never enters context)."),
			source: z.string().optional().describe("Label for the indexed content"),
		},
		async ({ content, path: filePath, source }) => {
			let text: string;
			let label = source ?? "indexed content";

			if (filePath) {
				const absPath = resolve(projectDir, filePath);
				if (!isWithinProject(absPath, projectDir)) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: path "${filePath}" is outside the project directory`,
							},
						],
						isError: true,
					};
				}
				try {
					const fileStat = statSync(absPath);
					if (fileStat.size > 50 * 1024 * 1024) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Error: file "${filePath}" is too large (${(fileStat.size / 1024 / 1024).toFixed(1)}MB). Max 50MB.`,
								},
							],
							isError: true,
						};
					}
					text = readFileSync(absPath, "utf-8");
					label = source ?? filePath;
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					return {
						content: [{ type: "text" as const, text: `Error reading "${filePath}": ${msg}` }],
						isError: true,
					};
				}
			} else if (content) {
				const contentBytes = Buffer.byteLength(content);
				if (contentBytes > 50 * 1024 * 1024) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: content too large (${(contentBytes / 1024 / 1024).toFixed(1)}MB). Max 50MB.`,
							},
						],
						isError: true,
					};
				}
				text = content;
			} else {
				return {
					content: [{ type: "text" as const, text: "Error: provide either 'content' or 'path'" }],
					isError: true,
				};
			}

			const result = store.index(text, label);
			tracker.trackIndexed(Buffer.byteLength(text));

			const summary = `Indexed "${label}": ${result.totalChunks} chunks (${result.codeChunks} with code). Use search(queries: [...]) to retrieve sections.`;
			tracker.trackCall("index", Buffer.byteLength(summary));

			return { content: [{ type: "text" as const, text: summary }] };
		},
	);
}
