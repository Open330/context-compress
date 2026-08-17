/** FTS5 highlight markers */
const STX = "\x02";
const ETX = "\x03";

const WINDOW = 300;
const DEFAULT_MAX_LEN = 1500;

/**
 * Extract match positions from FTS5 highlighted text.
 * FTS5 `highlight()` wraps matches with STX/ETX markers.
 */
export function positionsFromHighlight(highlighted: string): number[] {
	const positions: number[] = [];
	let offset = 0;
	let i = 0;

	while (i < highlighted.length) {
		if (highlighted[i] === STX) {
			positions.push(offset);
			i++;
		} else if (highlighted[i] === ETX) {
			i++;
		} else {
			offset++;
			i++;
		}
	}

	return positions;
}

/**
 * Remove STX/ETX markers from highlighted text.
 */
export function stripMarkers(text: string): string {
	return text.replaceAll(STX, "").replaceAll(ETX, "");
}

interface Window {
	start: number;
	end: number;
}

/**
 * Extract snippet windows around match positions.
 * Returns concatenated windows with ellipsis separators.
 */
export function extractSnippet(highlighted: string, maxLen: number = DEFAULT_MAX_LEN): string {
	const positions = positionsFromHighlight(highlighted);
	const clean = stripMarkers(highlighted);

	if (positions.length === 0 || clean.length <= maxLen) {
		return clean;
	}

	// Build windows around each match position
	const windows: Window[] = positions.map((pos) => ({
		start: Math.max(0, pos - WINDOW),
		end: Math.min(clean.length, pos + WINDOW),
	}));

	// Sort and merge overlapping windows
	windows.sort((a, b) => a.start - b.start);
	const merged: Window[] = [windows[0]];

	for (let i = 1; i < windows.length; i++) {
		const last = merged[merged.length - 1];
		if (windows[i].start <= last.end) {
			last.end = Math.max(last.end, windows[i].end);
		} else {
			merged.push(windows[i]);
		}
	}

	// Collect windows up to maxLen, clipping the one that crosses the limit.
	//
	// Dropping an oversized window instead of clipping it returned an EMPTY
	// snippet: when matches are dense they merge into a single span wider than
	// maxLen, that span failed the check on the first iteration, and the caller
	// got a hit with no content at all — worst for the densest, best-ranked hits.
	const parts: string[] = [];
	let total = 0;
	let clipped = false;

	for (const w of merged) {
		const remaining = maxLen - total;
		if (remaining <= 0) {
			clipped = true;
			break;
		}
		let slice = clean.slice(w.start, w.end);
		if (slice.length > remaining) {
			slice = slice.slice(0, remaining);
			clipped = true;
		}
		parts.push(slice);
		total += slice.length;
	}

	// Join with ellipsis at boundaries
	const lastWindow = merged[parts.length - 1];
	const endsEarly = clipped || (lastWindow !== undefined && lastWindow.end < clean.length);
	const snippets = parts.map((part, i) => {
		let s = part;
		if (i === 0 && merged[0].start > 0) s = `…${s}`;
		if (i < parts.length - 1) s = `${s}…`;
		else if (endsEarly) s = `${s}…`;
		return s;
	});

	return snippets.join("\n\n");
}
