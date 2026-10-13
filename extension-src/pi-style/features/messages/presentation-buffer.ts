/** Frame-aligned presentation only: Pi remains the owner of messages and scheduling. */
type Call = () => unknown;
type AssistantState = {
	lastMessage?: unknown;
	isStreaming?: boolean;
	hasToolCalls?: boolean;
	contentContainer?: unknown;
};
type Message = { content: { type: string }[]; stopReason?: string };

export class AssistantPresentationBuffer {
	enabled = false;
	private readonly pending = new Map<object, Call>();
	private cache = new WeakMap<object, { width: unknown; lines: string[] }>();

	update(instance: object, args: unknown[], call: Call): unknown {
		this.cache.delete(instance);
		const state = instance as AssistantState;
		const message = args[0] as Message | undefined;
		// Only explicit streaming updates are deferred. Internal invalidate/theme/
		// thinking setters omit the streaming argument and must rebuild immediately.
		if (
			!this.enabled ||
			args[1] !== true ||
			!state.lastMessage ||
			!state.contentContainer ||
			!message ||
			!Array.isArray(message.content) ||
			message.stopReason === "aborted" ||
			message.stopReason === "error" ||
			message.stopReason === "length"
		) {
			this.pending.delete(instance);
			return call();
		}
		state.lastMessage = message;
		state.isStreaming = true;
		state.hasToolCalls = message.content.some((part) => part.type === "toolCall");
		this.pending.set(instance, call);
		// Bound retained component references even if no render is requested.
		if (this.pending.size > 128) this.flush(this.pending.keys().next().value as object);
		return undefined;
	}

	render(instance: object, width: unknown, call: Call): unknown {
		this.flush(instance);
		if (!this.enabled || (instance as AssistantState).isStreaming !== false) return call();
		const cached = this.cache.get(instance);
		if (cached && cached.width === width) return [...cached.lines];
		const result = call();
		if (Array.isArray(result) && result.length <= 4096 && result.every((line) => typeof line === "string")) {
			// One width per component, weak ownership: history never accumulates widths.
			this.cache.set(instance, { width, lines: [...result] });
		}
		return result;
	}

	flush(instance: object): void {
		const call = this.pending.get(instance);
		this.pending.delete(instance);
		call?.();
	}

	flushAll(): void {
		for (const instance of this.pending.keys()) this.flush(instance);
	}

	dispose(): void {
		this.enabled = false;
		try {
			this.flushAll();
		} finally {
			this.pending.clear();
			this.cache = new WeakMap();
		}
	}
}
