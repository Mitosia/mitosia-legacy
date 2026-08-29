import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  episodeBriefTransportSchema,
  momentProposalTransportSchema,
  segmentPlanTransportSchema,
  segmentReconciliationTransportSchema,
} from "@/lib/ai/capabilities/episode-clips";
import {
  portableJsonSchema,
  portableOutputSchema,
} from "@/lib/ai/portable-schema";

// OpenRouter can route one model slug across several upstream implementations.
// Keep the wire contract inside the conservative JSON-Schema subset shared by
// GPT, Gemini, Claude, and Kimi; exact editorial constraints live in local Zod
// schemas and deterministic validators instead.

const schemas = {
  brief: episodeBriefTransportSchema,
  moments: momentProposalTransportSchema,
  reconcile: segmentReconciliationTransportSchema,
  segments: segmentPlanTransportSchema,
};

const PROVIDER_SCHEMA_BYTE_BUDGET = 4000;
const DISALLOWED_PROVIDER_KEYWORDS = new Set([
  "$schema",
  "allOf",
  "const",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "not",
  "pattern",
  "oneOf",
]);

function assertPortableNode(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertPortableNode(item);
    }
    return;
  }
  if (!(value && typeof value === "object")) {
    return;
  }
  const node = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(node)) {
    expect(DISALLOWED_PROVIDER_KEYWORDS.has(key), key).toBe(false);
    if (
      (key === "properties" || key === "$defs" || key === "definitions") &&
      child &&
      typeof child === "object" &&
      !Array.isArray(child)
    ) {
      for (const propertySchema of Object.values(child)) {
        assertPortableNode(propertySchema);
      }
    } else {
      assertPortableNode(child);
    }
  }
  if (node.type === "object" && node.properties) {
    const propertyNames = Object.keys(node.properties as object).sort();
    const required = Array.isArray(node.required)
      ? [...node.required].sort()
      : [];
    expect(required).toEqual(propertyNames);
    expect(node.additionalProperties).toBe(false);
  }
}

describe("provider-neutral episode transport schemas", () => {
  it.each(Object.entries(schemas))(
    "%s stays small and inside the portable strict subset",
    (_name, schema) => {
      const jsonSchema = portableJsonSchema(schema as z.ZodType<unknown>);
      expect(JSON.stringify(jsonSchema).length).toBeLessThan(
        PROVIDER_SCHEMA_BYTE_BUDGET
      );
      assertPortableNode(jsonSchema);
    }
  );

  it("preserves fields named like schema keywords and lowers literals", () => {
    const schema = z.object({
      format: z.string().min(2),
      mode: z.literal("brief"),
    });
    const jsonSchema = portableJsonSchema(schema);
    const properties = jsonSchema.properties as Record<
      string,
      Record<string, unknown>
    >;

    expect(properties.format).toEqual({ type: "string" });
    expect(properties.mode).toEqual({ enum: ["brief"], type: "string" });
    expect(jsonSchema).not.toHaveProperty("$schema");
    assertPortableNode(jsonSchema);
  });

  it("keeps the complete Zod contract as the local acceptance gate", () => {
    const exact = z.object({ score: z.number().min(0).max(2) });
    const providerSchema = portableOutputSchema(exact);

    expect(providerSchema.validate?.({ score: 3 })).toMatchObject({
      success: false,
    });
    expect(providerSchema.validate?.({ score: 2 })).toEqual({
      success: true,
      value: { score: 2 },
    });
  });
});
