/**
 * UTF-8 byte budgeting for tool responses.
 *
 * Response caps are configured in bytes, so they must be measured in bytes:
 * counting characters lets any multi-byte output silently exceed the cap, and
 * budgeting only the "interesting" section ignores headers, separators, and
 * footers that are part of the same response.
 */

export function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** True for a UTF-8 continuation byte (10xxxxxx), which must never start a slice. */
function isContinuation(byte: number | undefined): boolean {
	return byte !== undefined && (byte & 0xc0) === 0x80;
}

/** Byte-truncate without splitting a multi-byte character. */
function sliceBytes(buffer: Buffer, limit: number): string {
	let cut = Math.min(limit, buffer.length);
	while (cut > 0 && isContinuation(buffer[cut])) cut--;
	return buffer.subarray(0, cut).toString("utf8");
}

/**
 * Truncate `text` so the result is at most `maxBytes` UTF-8 bytes, keeping the
 * marker so a caller can tell truncation from a short answer.
 */
export function truncateToBytes(
	text: string,
	maxBytes: number,
	marker = "\n\n… [truncated: response byte budget reached]",
): string {
	if (maxBytes <= 0) return "";
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= maxBytes) return text;

	const markerBuffer = Buffer.from(marker, "utf8");
	// Too small to hold body + marker: emit as much of the marker as fits, so the
	// response still says it was cut rather than looking like real content.
	if (maxBytes <= markerBuffer.length) return sliceBytes(markerBuffer, maxBytes);

	return sliceBytes(buffer, maxBytes - markerBuffer.length) + marker;
}

/**
 * Admits separator-joined blocks while a byte limit holds, and counts what it
 * had to drop.
 */
class BlockBudget {
	private readonly kept: string[] = [];
	private used = 0;
	private dropped = 0;

	constructor(
		private readonly limit: number,
		private readonly separatorBytes: number,
	) {}

	/** True when the block was admitted; false when it did not fit. */
	offer(block: string): boolean {
		const cost = byteLength(block) + (this.kept.length > 0 ? this.separatorBytes : 0);
		if (this.used + cost > this.limit) {
			// A first block bigger than the whole budget used to vanish, leaving the
			// caller an omission note and no content: measured, a search whose only
			// matching block was oversized returned 61 bytes and none of the answer.
			// Block size is driven by caller-supplied labels and titles, neither of
			// which is bounded, so this is reachable without a huge document. A
			// clipped answer beats no answer, and truncateToBytes says it was cut.
			if (this.kept.length === 0 && this.used < this.limit) {
				this.kept.push(truncateToBytes(block, this.limit - this.used));
				this.used = this.limit;
				return true;
			}
			this.dropped++;
			return false;
		}
		this.kept.push(block);
		this.used += cost;
		return true;
	}

	push(block: string): void {
		this.kept.push(block);
		this.used += byteLength(block);
	}

	get omitted(): number {
		return this.dropped;
	}

	join(separator: string): string {
		return this.kept.join(separator);
	}
}

interface BudgetedResponse {
	/** Body blocks, admitted in order until the budget is spent. */
	blocks: string[];
	/** Total response budget in UTF-8 bytes. */
	limit: number;
	/** Always-included prefix, reserved before any block is admitted. */
	header?: string;
	/** Always-included suffix, reserved before any block is admitted. */
	footer?: string;
	/** A final block that must always be kept, such as a rate-limit notice. */
	trailing?: string;
	separator?: string;
	/** Renders the note appended when blocks had to be dropped. */
	omissionNote: (omitted: number) => string;
}

/**
 * Assemble a response that is guaranteed to fit `limit` UTF-8 bytes.
 *
 * The fixed parts are reserved first, so the budget covers the whole response
 * rather than only its body; dropped blocks are reported instead of vanishing;
 * and the result is clamped at the end, because a caller may configure a limit
 * smaller than the fixed parts themselves.
 */
export function assembleBudgetedResponse(options: BudgetedResponse): string {
	const {
		blocks,
		limit,
		header = "",
		footer = "",
		trailing = "",
		separator = "\n---\n\n",
		omissionNote,
	} = options;

	const separatorBytes = byteLength(separator);
	const reserved =
		byteLength(header) +
		byteLength(footer) +
		byteLength(trailing) +
		(trailing ? separatorBytes : 0) +
		(blocks.length > 0 ? byteLength(omissionNote(blocks.length)) : 0);

	const budget = new BlockBudget(limit - reserved, separatorBytes);
	for (const block of blocks) budget.offer(block);
	if (trailing) budget.push(trailing);

	let output = header + budget.join(separator);
	if (budget.omitted > 0) output += omissionNote(budget.omitted);
	output += footer;
	return truncateToBytes(output, limit);
}
