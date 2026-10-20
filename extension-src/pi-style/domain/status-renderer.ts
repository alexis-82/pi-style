import type {
	SegmentContext,
	SegmentRenderResult,
	StatusLayout,
	StatusRenderResult,
	StatusSegment,
	StatusSegmentId,
	StatusSnapshot,
} from "../domain/status.js";
import type { ResolvedTheme } from "../domain/theme.js";
import { truncateAnsi, visibleWidth } from "../shared/ansi.js";

export interface StatusRendererOptions {
	readonly separator?: string;
	readonly padding?: string;
	readonly segments: ReadonlyMap<StatusSegmentId, StatusSegment>;
	readonly theme: ResolvedTheme;
	readonly options?: Readonly<
		Record<string, { readonly disabled?: boolean; readonly [key: string]: unknown } | undefined>
	>;
}

interface Candidate {
	readonly id: StatusSegmentId;
	readonly segment: StatusSegment;
	readonly result: SegmentRenderResult;
	content: string;
	/** Visible width of `content`; updated when the compact form is swapped in. */
	contentWidth: number;
	compact: boolean;
	moved: boolean;
}

function uniqueLayout(layout: StatusLayout): StatusLayout {
	const seen = new Set<StatusSegmentId>();
	const dedupe = (items: readonly StatusSegmentId[]) =>
		items.filter((id) => {
			if (seen.has(id)) return false;
			seen.add(id);
			return true;
		});
	return { left: dedupe(layout.left), right: dedupe(layout.right), secondary: dedupe(layout.secondary) };
}

function renderGroup(items: readonly Candidate[], separator: string, padding: string): string {
	return items
		.map((item) => item.content)
		.filter(Boolean)
		.join(`${padding}${separator}${padding}`);
}

export function renderStatus(
	layout: StatusLayout,
	snapshot: StatusSnapshot,
	width: number,
	options: StatusRendererOptions,
): StatusRenderResult {
	if (width <= 0) return { primary: "", lines: [], visibleSegments: [] };
	const separator = options.separator ?? "|";
	const padding = options.padding ?? " ";
	const normalized = uniqueLayout(layout);
	const context: SegmentContext = { snapshot, theme: options.theme, options: options.options ?? {}, width };
	const candidates = new Map<StatusSegmentId, Candidate>();
	for (const id of [...normalized.left, ...normalized.right, ...normalized.secondary]) {
		if (candidates.has(id)) continue;
		const segment = options.segments.get(id);
		if (!segment || options.options?.[id]?.disabled) continue;
		try {
			const result = segment.render(context);
			if (!result.visible || !result.content) continue;
			candidates.set(id, {
				id,
				segment,
				result,
				content: result.content,
				contentWidth: visibleWidth(result.content),
				compact: false,
				moved: false,
			});
		} catch {
			// A broken optional segment must not break the status row.
		}
	}
	const primary = [...normalized.left, ...normalized.right]
		.map((id) => candidates.get(id))
		.filter((candidate): candidate is Candidate => candidate !== undefined)
		.sort(
			(a, b) =>
				(b.segment.essential ? 1 : 0) - (a.segment.essential ? 1 : 0) ||
				b.segment.defaultPriority - a.segment.defaultPriority,
		);
	const secondary = normalized.secondary
		.map((id) => candidates.get(id))
		.filter((candidate): candidate is Candidate => candidate !== undefined);
	const visible: Candidate[] = [];
	const overflow: Candidate[] = [];
	// Incremental fit tracking: the rendered width of a group is the sum of the
	// member content widths plus one separator gap between consecutive members
	// (every join boundary is broken by the separator string, so visible widths
	// add up). This replaces re-joining and re-measuring the whole group after
	// every push, which made the overflow loop quadratic in segment count.
	const gapWidth = visibleWidth(`${padding}${separator}${padding}`);
	let groupWidth = 0;
	let groupCount = 0;
	const widthAfter = (baseWidth: number, count: number, candidate: Candidate): number =>
		count === 0 ? candidate.contentWidth : baseWidth + gapWidth + candidate.contentWidth;
	for (const candidate of primary) {
		visible.push(candidate);
		const pushedWidth = widthAfter(groupWidth, groupCount, candidate);
		if (pushedWidth <= width) {
			groupWidth = pushedWidth;
			groupCount++;
			continue;
		}
		if (candidate.result.compactContent && !candidate.compact) {
			candidate.content = candidate.result.compactContent;
			candidate.compact = true;
			candidate.contentWidth = visibleWidth(candidate.content);
			const compactedWidth = widthAfter(groupWidth, groupCount, candidate);
			if (compactedWidth <= width) {
				groupWidth = compactedWidth;
				groupCount++;
				continue;
			}
		}
		visible.pop();
		if (candidate.segment.overflow !== "drop" && candidate.segment.overflow !== "primary") {
			candidate.moved = true;
			overflow.push(candidate);
		}
	}
	for (const candidate of [...overflow].sort((a, b) => b.segment.defaultPriority - a.segment.defaultPriority))
		secondary.push(candidate);
	// Right-aligned trailing group: layout.right candidates render flush to the
	// right edge, mirroring Pi's native footer (model • effort on the far right).
	// Group order follows the layout declaration; the priority sort above only
	// decides what drops on overflow.
	const visibleIds = new Set(visible.map((candidate) => candidate.id));
	const groupOf = (group: readonly StatusSegmentId[]) =>
		group
			.map((id) => candidates.get(id))
			.filter((candidate): candidate is Candidate => candidate !== undefined && visibleIds.has(candidate.id));
	const leftVisible = groupOf(normalized.left);
	const rightVisible = groupOf(normalized.right);
	const leftText = renderGroup(leftVisible, separator, padding);
	const rightText = renderGroup(rightVisible, separator, padding);
	let primaryText: string;
	if (!rightText) {
		primaryText = leftText;
	} else {
		const core = leftText ? `${leftText}${padding}${separator}${padding}` : "";
		// The fit pass already budgets separators; add only the remaining space.
		// A minimum gap can overflow an otherwise fitted row and force truncation.
		const gap = Math.max(0, width - visibleWidth(core) - visibleWidth(rightText));
		primaryText = `${core}${" ".repeat(gap)}${rightText}`;
	}
	if (visibleWidth(primaryText) > width) primaryText = truncateAnsi(primaryText, width);
	const secondaryVisible: Candidate[] = [];
	let secondaryWidth = 0;
	let secondaryCount = 0;
	for (const candidate of [...secondary].sort((a, b) => b.segment.defaultPriority - a.segment.defaultPriority)) {
		const pushedWidth = widthAfter(secondaryWidth, secondaryCount, candidate);
		if (pushedWidth > width) continue;
		secondaryVisible.push(candidate);
		secondaryWidth = pushedWidth;
		secondaryCount++;
	}
	const secondaryText = renderGroup(secondaryVisible, separator, padding);
	const lines = secondaryText ? [primaryText, secondaryText] : primaryText ? [primaryText] : [];
	return {
		primary: primaryText,
		...(secondaryText ? { secondary: secondaryText } : {}),
		lines,
		visibleSegments: [...visible, ...secondaryVisible].map((candidate) => candidate.id),
	};
}
