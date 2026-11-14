import { ConfigSchema } from "./schema.js";

export const CONFIG_SCHEMA_URL =
  "https://cdn.jsdelivr.net/npm/@kongyo2/kongyo-scan/schemas/config.schema.json";

export function configJsonSchema(): Record<string, unknown> {
  const { $schema, ...rest } = ConfigSchema.toJSONSchema({
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  return {
    $schema,
    $id: CONFIG_SCHEMA_URL,
    title: "kongyo-scan settings",
    description:
      "Settings for kongyo-scan: model providers in fallback order, scan defaults, limits, and native Codex settings.",
    ...rest,
  };
}
