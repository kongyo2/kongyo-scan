import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Build once so tests that spawn the executable run the current sources. */
export default function setup(): void {
  if (process.env["KONGYO_SCAN_SKIP_BUILD"] === "1" && existsSync(`${root}dist/cli.js`)) return;
  execFileSync(process.execPath, ["--run", "build"], { cwd: root, stdio: "inherit" });
}
