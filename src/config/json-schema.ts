import { ConfigSchema } from "./schema.js";

/** Where the published schema is served from (the npm package, through a CDN), for the `$schema` key of a settings file. */
export const CONFIG_SCHEMA_URL =
  "https://cdn.jsdelivr.net/npm/@kongyo2/kongyo-scan/schemas/config.schema.json";

/** JSON Schema for settings files, so editors can complete and validate them. */
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
