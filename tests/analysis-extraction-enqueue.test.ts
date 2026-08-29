import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAiConfigured: vi.fn(() => true),
  trigger: vi.fn(),
  withOrgScope: vi.fn(),
}));

vi.mock("@/lib/ai/provider", () => ({
  isAiConfigured: mocks.isAiConfigured,
}));
vi.mock("@/lib/db/tenant", () => ({
  withOrgScope: mocks.withOrgScope,
}));
vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger: mocks.trigger } }));
vi.mock("@/trigger/analyze-source", () => ({ analyzeSourceTask: {} }));
vi.mock("@/trigger/extract-source", () => ({ extractSourceTask: {} }));

import { enqueueAnalysis } from "@/lib/analysis/enqueue";
import {
  enqueueExtraction,
  enqueueExtractionRerun,
} from "@/lib/intelligence/extract-enqueue";

const payload = { organizationId: "org-1", sourceId: "source-1" };

describe("analysis and extraction enqueue leases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("TRIGGER_SECRET_KEY", "trigger-secret");
    mocks.isAiConfigured.mockReturnValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("does not dispatch analysis when another enqueue owns the row", async () => {
    mocks.withOrgScope.mockResolvedValueOnce([]);

    await expect(enqueueAnalysis(payload)).resolves.toBeUndefined();

    expect(mocks.trigger).not.toHaveBeenCalled();
    expect(mocks.withOrgScope).toHaveBeenCalledOnce();
  });

  it("keeps analysis pending when dispatch fails", async () => {
    const error = new Error("queue unavailable");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.withOrgScope.mockResolvedValueOnce([{ id: "analysis-1" }]);
    mocks.trigger.mockRejectedValueOnce(error);

    await expect(enqueueAnalysis(payload)).resolves.toBeUndefined();

    expect(mocks.trigger).toHaveBeenCalledOnce();
    expect(mocks.withOrgScope).toHaveBeenCalledOnce();
  });

  it("does not dispatch automatic extraction when insert loses", async () => {
    mocks.withOrgScope.mockResolvedValueOnce([]);

    await expect(enqueueExtraction(payload)).resolves.toBeUndefined();

    expect(mocks.trigger).not.toHaveBeenCalled();
    expect(mocks.withOrgScope).toHaveBeenCalledOnce();
  });

  it("does not dispatch a rerun when no state transition wins", async () => {
    mocks.withOrgScope.mockResolvedValueOnce([]);

    await expect(enqueueExtractionRerun(payload)).resolves.toBeUndefined();

    expect(mocks.trigger).not.toHaveBeenCalled();
    expect(mocks.withOrgScope).toHaveBeenCalledOnce();
  });

  it("keeps extraction pending when dispatch fails", async () => {
    const error = new Error("queue unavailable");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.withOrgScope.mockResolvedValueOnce([{ id: "extract-1" }]);
    mocks.trigger.mockRejectedValueOnce(error);

    await expect(enqueueExtractionRerun(payload)).resolves.toBeUndefined();

    expect(mocks.trigger).toHaveBeenCalledOnce();
    expect(mocks.withOrgScope).toHaveBeenCalledOnce();
  });
});
