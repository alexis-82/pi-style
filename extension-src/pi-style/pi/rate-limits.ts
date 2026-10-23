import type { RateLimitsSnapshot, RateLimitWindow } from "../domain/status.js";

/**
 * Read subscription plan utilization from Anthropic response headers
 * (`anthropic-ratelimit-unified-{5h,7d}-utilization` as a 0-1 fraction and
 * `-reset` as epoch seconds). Returns undefined when the response carries none,
 * e.g. API-key auth or a non-Anthropic provider.
 */
export function rateLimitsFromHeaders(headers: Readonly<Record<string, string>>): RateLimitsSnapshot | undefined {
	const lower = new Map<string, string>();
	for (const [key, value] of Object.entries(headers)) lower.set(key.toLowerCase(), value);
	const read = (window: "5h" | "7d"): RateLimitWindow | undefined => {
		const raw = lower.get(`anthropic-ratelimit-unified-${window}-utilization`);
		const utilization = Number(raw);
		if (raw === undefined || raw.trim() === "" || !Number.isFinite(utilization)) return undefined;
		const reset = Number(lower.get(`anthropic-ratelimit-unified-${window}-reset`));
		return {
			percent: Math.max(0, Math.min(100, Math.round(utilization * 1000) / 10)),
			...(Number.isFinite(reset) && reset > 0 ? { resetsAt: reset } : {}),
		};
	};
	const fiveHour = read("5h");
	const weekly = read("7d");
	if (!fiveHour && !weekly) return undefined;
	return { ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}) };
}
