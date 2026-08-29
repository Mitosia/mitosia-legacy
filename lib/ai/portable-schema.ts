import { jsonSchema, type Schema } from "ai";
import { z } from "zod";

// The frontier models behind OpenRouter do not implement the same JSON Schema
// dialect. Keep the wire grammar to their shared structural subset and let the
// original Zod schema remain the authoritative local compiler. Removing a
// constraint here never weakens application state: jsonSchema.validate runs
// the complete Zod parse before generateObject can return a value.
const LOCAL_ONLY_KEYWORDS = new Set([
  "$schema",
  "allOf",
  "contentEncoding",
  "contentMediaType",
  "default",
  "examples",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "not",
  "pattern",
  "readOnly",
  "uniqueItems",
  "writeOnly",
]);

function lowerNode(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(lowerNode);
  }
  if (!(value && typeof value === "object")) {
    return value;
  }

  const lowered: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      (key === "properties" || key === "$defs" || key === "definitions") &&
      child &&
      typeof child === "object" &&
      !Array.isArray(child)
    ) {
      lowered[key] = Object.fromEntries(
        Object.entries(child).map(([name, propertySchema]) => [
          name,
          lowerNode(propertySchema),
        ])
      );
      continue;
    }
    if (LOCAL_ONLY_KEYWORDS.has(key)) {
      continue;
    }
    if (key === "const") {
      lowered.enum = [lowerNode(child)];
      continue;
    }
    if (key === "oneOf") {
      lowered.anyOf = lowerNode(child);
      continue;
    }
    lowered[key] = lowerNode(child);
  }

  if (lowered.type === "object" && lowered.properties) {
    // OpenAI-compatible strict output requires every declared property and
    // closed objects. Exact optionality is still enforced by local Zod; asking
    // for the field on the wire removes provider-specific optional semantics.
    lowered.required = Object.keys(
      lowered.properties as Record<string, unknown>
    );
    lowered.additionalProperties = false;
  }
  return lowered;
}

export function portableJsonSchema<Output>(
  schema: z.ZodType<Output>
): Record<string, unknown> {
  const draft7 = z.toJSONSchema(schema, { target: "draft-7" });
  return lowerNode(draft7) as Record<string, unknown>;
}

export function portableOutputSchema<Output>(
  schema: z.ZodType<Output>
): Schema<Output> {
  const providerSchema = portableJsonSchema(schema);
  return jsonSchema<Output>(
    providerSchema as Parameters<typeof jsonSchema>[0],
    {
      validate: (value) => {
        const parsed = schema.safeParse(value);
        return parsed.success
          ? { success: true, value: parsed.data }
          : { error: parsed.error, success: false };
      },
    }
  );
}
