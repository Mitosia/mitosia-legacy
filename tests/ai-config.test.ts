import { afterEach, describe, expect, it } from "vitest";
import { EFFORT_TIERS, routeForTask, TASK_ROUTES } from "../lib/ai/config";

// Config-level invariants for the AI task table. The first wired-effort
// call on staging (2026-08-24) failed every extraction with "This model
// does not support the effort parameter" — claude-haiku-4-5 rejects
// effort outright. The generate seam gates on EFFORT_TIERS too, but a
// declared-yet-inert effort in the table is a lie waiting for the gate to
// be refactored away; this keeps the table honest.

describe("TASK_ROUTES", () => {
  it("never declares effort on a tier that rejects the parameter", () => {
    for (const [task, route] of Object.entries(TASK_ROUTES)) {
      if ("effort" in route && route.effort !== undefined) {
        expect(
          EFFORT_TIERS.has(route.tier),
          `${task} declares effort on tier "${route.tier}", which rejects the effort parameter`
        ).toBe(true);
      }
    }
  });

  it("gives every route a positive output budget", () => {
    for (const route of Object.values(TASK_ROUTES)) {
      expect(route.maxOutputTokens).toBeGreaterThan(0);
    }
  });
});

describe("tier overrides", () => {
  afterEach(() => {
    process.env.MOMENT_DISCOVERY_TIER = undefined;
    delete process.env.MOMENT_DISCOVERY_TIER;
    delete process.env.SEGMENT_PLAN_TIER;
  });

  it("routes the discovery pass to the overridden tier", () => {
    process.env.MOMENT_DISCOVERY_TIER = "opus";
    expect(routeForTask("moment-discovery.candidates").tier).toBe("opus");
    // Untouched tasks keep their table tier.
    expect(routeForTask("source-extraction.claims").tier).toBe("sonnet");
  });

  it("ignores invalid values", () => {
    process.env.MOMENT_DISCOVERY_TIER = "gpt-5";
    expect(routeForTask("moment-discovery.candidates").tier).toBe("sonnet");
  });

  it("drops effort when the override tier rejects it", () => {
    process.env.SEGMENT_PLAN_TIER = "haiku";
    const route = routeForTask("segment-plan.partition");
    expect(route.tier).toBe("haiku");
    expect(route.effort).toBeUndefined();
  });
});
