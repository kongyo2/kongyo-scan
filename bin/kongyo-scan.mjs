#!/usr/bin/env node
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  process.stderr.write(
    `Error: kongyo-scan needs Node.js 22.13 or newer. You have ${process.versions.node}.\n\n` +
      "  Install a supported version (22.x, 24.x, or 26.x), then run kongyo-scan again.\n",
  );
  process.exit(1);
}

try {
  const { run } = await import("../dist/cli.js");
  await run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `Error: kongyo-scan failed to start. ${message.replaceAll(/\p{Cc}/gu, " ")}\n`,
  );
  process.exit(1);
}
