// Writes schemas/config.schema.json from the built settings schema. Run with `node --run schema`.
import { mkdir, writeFile } from "node:fs/promises";

const { configJsonSchema } = await import("../dist/config/json-schema.js");
const directory = new URL("../schemas/", import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(
  new URL("config.schema.json", directory),
  `${JSON.stringify(configJsonSchema(), null, 2)}\n`,
  "utf8",
);
