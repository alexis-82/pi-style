import { describe, expect, it } from "vitest";
import { rateLimitsFromHeaders } from "../../extension-src/pi-style/pi/rate-limits.js";

describe("rateLimitsFromHeaders", () => {
	it("reads Anthropic unified 5h/7d utilization and reset headers", () => {
		expect(
			rateLimitsFromHeaders({
				"anthropic-ratelimit-unified-5h-utilization": "0.42",
				"anthropic-ratelimit-unified-5h-reset": "1761235200",
				"Anthropic-Ratelimit-Unified-7d-Utilization": "0.07",
			}),
		).toEqual({ fiveHour: { percent: 42, resetsAt: 1761235200 }, weekly: { percent: 7 } });
	});

	it("clamps out-of-range utilization", () => {
		expect(rateLimitsFromHeaders({ "anthropic-ratelimit-unified-7d-utilization": "1.3" })).toEqual({
			weekly: { percent: 100 },
		});
	});

	it("returns undefined without plan headers", () => {
		expect(rateLimitsFromHeaders({ "content-type": "text/event-stream" })).toBeUndefined();
		expect(rateLimitsFromHeaders({ "anthropic-ratelimit-unified-5h-utilization": "" })).toBeUndefined();
		expect(rateLimitsFromHeaders({ "anthropic-ratelimit-unified-5h-utilization": "n/a" })).toBeUndefined();
	});
});
