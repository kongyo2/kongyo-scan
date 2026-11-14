import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { CONFIG_SCHEMA_URL, configJsonSchema } from "../../src/config/json-schema.js";
import { ConfigSchema } from "../../src/config/schema.js";

describe("published settings schema", () => {
  it("matches the settings the CLI accepts", async () => {
    const published = JSON.parse(
      await readFile(new URL("../../schemas/config.schema.json", import.meta.url), "utf8"),
    ) as unknown;
    // Regenerate with `node --run schema` after changing src/config/schema.ts.
    expect(published).toEqual(configJsonSchema());
  });

  it("describes a strict object with documented settings", () => {
    const schema = configJsonSchema() as {
      $id: string;
      additionalProperties: boolean;
      properties: Record<string, { description?: string }>;
    };
    expect(schema.$id).toBe(CONFIG_SCHEMA_URL);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(Object.keys(ConfigSchema.shape));
    for (const name of ["providers", "reasoning_effort", "codex", "python"]) {
      expect(schema.properties[name]?.description, name).toBeTruthy();
    }
  });
});
