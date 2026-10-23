import type { PresetName } from "./config-types.js";
import type { StatusLayout, StatusSegmentId } from "./status.js";

export const STATUS_PRESETS: Readonly<Record<PresetName, StatusLayout>> = Object.freeze({
	default: Object.freeze({
		left: ["claude_line"],
		right: [],
		secondary: ["extension_statuses"],
	}),
	minimal: Object.freeze({ left: ["path", "git"], right: ["context_pct"], secondary: [] }),
	compact: Object.freeze({
		left: ["model", "thinking", "git"],
		right: ["context_pct"],
		secondary: ["extension_statuses"],
	}),
	full: Object.freeze({
		left: ["hostname", "model", "thinking", "path", "git", "session"],
		right: ["token_in", "token_out", "cache_read", "cost", "context_pct", "time_spent", "time"],
		secondary: ["extension_statuses"],
	}),
	ascii: Object.freeze({
		left: ["path", "git", "context_bar", "cost"],
		right: ["model_effort"],
		secondary: ["extension_statuses"],
	}),
	native: Object.freeze({ left: ["model", "path"], right: ["context_pct"], secondary: [] }),
});

function unique(values: readonly unknown[]): StatusSegmentId[] {
	const result: StatusSegmentId[] = [];
	for (const value of values) {
		if (typeof value !== "string" || result.includes(value)) continue;
		result.push(value);
	}
	return result;
}

export function normalizeStatusLayout(
	preset: PresetName,
	input:
		| {
				left?: readonly unknown[] | undefined;
				right?: readonly unknown[] | undefined;
				secondary?: readonly unknown[] | undefined;
		  }
		| undefined,
): StatusLayout {
	const base = STATUS_PRESETS[preset] ?? STATUS_PRESETS.default;
	const left = input?.left === undefined ? base.left : unique(input.left);
	const right = input?.right === undefined ? base.right : unique(input.right);
	const secondary = input?.secondary === undefined ? base.secondary : unique(input.secondary);
	const seen = new Set<StatusSegmentId>();
	const dedupe = (values: readonly StatusSegmentId[]) =>
		values.filter((value) => {
			if (seen.has(value)) return false;
			seen.add(value);
			return true;
		});
	return Object.freeze({ left: dedupe(left), right: dedupe(right), secondary: dedupe(secondary) });
}
