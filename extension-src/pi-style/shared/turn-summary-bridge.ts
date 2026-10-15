// Cross-feature bridge for the merged turn-summary line
// (`◈ Thought N times · Called M tools · …`).
//
// depcruise forbids sibling-feature imports, so the tools-side turn registry
// (features/tools/boxed/turn-summary.ts) and the messages-side thought groups
// (features/messages/thought-summary.ts) meet here instead. This module is a
// pure data/registry seam: it imports nothing and owns no rendering.
//
// Data flow (all publishers run BEFORE the consumers rebuild):
// - The turn registry publishes per-message tool stats (one assistant message
//   = one stats record covering exactly its tool calls) when a run finalizes
//   (`finishAgentRun`, restore rebuild).
// - The thought groups publish which messages belong to an ENDED segment
//   (`finishAgentThoughtRun`, restore rebuild).
// - The thought-segment leader label reads `mergedStatsFor(group.messages)`;
//   the tool dispatcher hides the run's `➔` leader when every message of the
//   run belongs to an ended segment (so the merged lines carry the counts).
// - The turn registry registers `toggleTurnsForMessages` so the merged
//   thought-label click can open/close the run's tool blocks without the
//   messages feature importing the registry.
//
// All maps are weak: records live exactly as long as the session's message
// objects, so session resets need no explicit clearing.

/** Tool-call stats attributed to one assistant message. */
export interface MergedSegmentStats {
	/** Tool calls of the message (all members, mutating and failed included). */
	readonly calls: number;
	/** Aggregate diff stats when any member carried them. */
	readonly diff?: { readonly additions: number; readonly removals: number };
	/** Failed members. */
	readonly failed: number;
}

let statsByMessage = new WeakMap<object, MergedSegmentStats>();
let endedGroupMessages = new WeakSet<object>();

/** Rebuild/session boundaries must not retain attribution from an old branch. */
export function resetSummaryBridge(): void {
	statsByMessage = new WeakMap();
	endedGroupMessages = new WeakSet();
}

/** One canonical, duration-free run label, shared by thought and tools-only runs.
 *  The thought clause appears only when N > 0 (ADR 0012 §7): tools-only runs
 *  render `◈ Called N tools · …` with no `Thought 0 times` noise. The `Called`
 *  part is omitted entirely when the stats carry no tool calls (thought-only
 *  runs and tool-less prefixes render `◈ Thought N times`). */
export function mergedSummaryText(glyph: string, thoughts: number, stats: MergedSegmentStats): string {
	const parts: string[] = [];
	if (thoughts > 0) parts.push(`Thought ${thoughts} ${thoughts === 1 ? "time" : "times"}`);
	if (stats.calls > 0) parts.push(`Called ${stats.calls} ${stats.calls === 1 ? "tool" : "tools"}`);
	if (stats.diff && (stats.diff.additions > 0 || stats.diff.removals > 0))
		parts.push(`Edit +${stats.diff.additions} -${stats.diff.removals}`);
	if (stats.failed > 0) parts.push(`${stats.failed} ${stats.failed === 1 ? "failure" : "failures"}`);
	return parts.length > 0 ? `${glyph} ${parts.join(" · ")}` : glyph;
}

/** Publish one assistant message's tool stats (turn registry, run finalize). */
export function publishMessageStats(message: object, stats: MergedSegmentStats): void {
	statsByMessage.set(message, stats);
}

/** Publish that an assistant message belongs to an ended thought segment. */
export function publishEndedGroupMessage(message: object): void {
	endedGroupMessages.add(message);
}

/** Combined stats across the messages a thought segment covers; undefined when
 *  none of them carried tool calls (the segment keeps its thought-only label). */
export function mergedStatsFor(messages: readonly object[]): MergedSegmentStats | undefined {
	let calls = 0;
	let failed = 0;
	let additions = 0;
	let removals = 0;
	let diffMembers = 0;
	let seen = 0;
	for (const message of new Set(messages)) {
		const stats = statsByMessage.get(message);
		if (!stats) continue;
		seen++;
		calls += stats.calls;
		failed += stats.failed;
		if (stats.diff !== undefined) {
			additions += stats.diff.additions;
			removals += stats.diff.removals;
			diffMembers++;
		}
	}
	if (seen === 0) return undefined;
	return {
		calls,
		failed,
		...(diffMembers > 0 ? { diff: { additions, removals } } : {}),
	};
}

/** Whether every message of a run belongs to an ended thought group — the
 *  precondition for hiding the tool leader in favor of the merged thought
 *  row. Unattributed/tools-only runs retain a ◈ fallback, never a second ➔. */
export function everyMessageInEndedGroup(messages: readonly object[] | undefined): boolean {
	if (!messages || messages.length === 0) return false;
	return messages.every((message) => endedGroupMessages.has(message));
}

/** Registered by the turn registry at module load: opens/closes every ended
 *  turn whose members belong to the given messages (the merged thought-label
 *  click). The indirection keeps this module import-free. */
let turnToggleHandler: ((messages: readonly object[], open?: boolean) => boolean) | undefined;
let turnOpenReader: ((messages: readonly object[]) => boolean) | undefined;

/** Register (or clear) the tools-side run controls without sibling imports. */
export function registerTurnToggleHandler(
	handler: ((messages: readonly object[], open?: boolean) => boolean) | undefined,
	isOpen?: (messages: readonly object[]) => boolean,
): void {
	turnToggleHandler = handler;
	turnOpenReader = isOpen;
}

/** Native per-tool expansion is authoritative, including clicks and Ctrl+O. */
export function turnsOpenForMessages(messages: readonly object[]): boolean {
	return turnOpenReader?.(messages) ?? false;
}

/** Toggle, or explicitly set, every tool block of these runs. */
export function toggleTurnsForMessages(messages: readonly object[], open?: boolean): boolean {
	return turnToggleHandler?.(messages, open) ?? false;
}
