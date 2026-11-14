import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { VERSION } from "../../src/version.js";
import { chatChunk, type FakeUpstream, fakeUpstream, runCli, sendSse } from "../helpers.js";

const SECRET = "sk-test-0123456789abcdefSECRET";

let home: string;
let work: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "kscan-home-"));
  work = await mkdtemp(join(tmpdir(), "kscan-work-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

function cli(
  args: readonly string[],
  options: { env?: Record<string, string>; stdin?: string; cwd?: string } = {},
) {
  return runCli(args, {
    home,
    cwd: options.cwd ?? work,
    ...(options.env ? { env: options.env } : {}),
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
  });
}

function parseJson(text: string): Record<string, any> {
  expect(text.endsWith("\n")).toBe(true);
  expect(text.trim().split("\n")).toHaveLength(1);
  return JSON.parse(text) as Record<string, any>;
}

describe("help and version", () => {
  it("prints the version alone on stdout", async () => {
    const plain = await cli(["--version"]);
    expect(plain).toEqual({ code: 0, stdout: `${VERSION}\n`, stderr: "" });
    const json = await cli(["--version", "--json"]);
    expect(parseJson(json.stdout)).toEqual({ version: VERSION });
    expect((await cli(["-v"])).stdout).toBe(`${VERSION}\n`);
    expect(parseJson((await cli(["--help", "--json"])).stdout)["path"]).toBe("kongyo-scan");
  });

  it("prints help on stdout for every form of the request", async () => {
    const root = await cli(["--help"]);
    expect(root.code).toBe(0);
    expect(root.stderr).toBe("");
    expect(root.stdout).toMatch(/^kongyo-scan \[command\] \[options\]\n/u);
    for (const command of [
      "scan",
      "scans",
      "providers",
      "config",
      "init",
      "doctor",
      "codex-security",
      "help",
    ]) {
      expect(root.stdout).toMatch(new RegExp(`^  ${command}\\b`, "mu"));
    }
    expect(root.stdout).not.toContain("\u001b[");

    const viaFlag = await cli(["providers", "add", "--help"]);
    const viaCommand = await cli(["help", "providers", "add"]);
    expect(viaFlag.stdout).toBe(viaCommand.stdout);
    expect(viaFlag.stdout).toContain("--api-key-stdin");
    expect((await cli(["scan", "--no-such-option", "-h"])).code).toBe(0);
  });

  it("describes commands as JSON", async () => {
    const document = parseJson((await cli(["scan", "--help", "--json"])).stdout);
    expect(document["path"]).toBe("kongyo-scan scan");
    expect(document["options"].map((option: { name: string }) => option.name)).toContain(
      "--fail-on-severity",
    );
    const all = parseJson((await cli(["help", "--all", "--json"])).stdout);
    const paths = all["commands"].map((command: { path: string }) => command.path);
    expect(paths).toContain("kongyo-scan providers move");
    expect(paths).toContain("kongyo-scan scans export");
  });
});

describe("usage errors", () => {
  it("refuses to open the interactive UI without a terminal", async () => {
    const result = await cli([]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Error: Can't open the interactive UI without a terminal (no terminal).",
    );
    expect(result.stderr).toContain("    kongyo-scan scan\n");
  });

  it("names the mistake and the fix, and exits with 2", async () => {
    const unknown = await cli(["provders", "list"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stdout).toBe("");
    expect(unknown.stderr).toContain("Unknown command provders");
    expect(unknown.stderr).toContain("providers");

    const option = await cli(["scan", "--fial-on-severity", "high"]);
    expect(option.code).toBe(2);
    expect(option.stderr).toContain("--fail-on-severity");

    const json = await cli(["scan", "--mode", "fast", "--json"]);
    expect(json.code).toBe(2);
    expect(json.stdout).toBe("");
    const error = parseJson(json.stderr);
    expect(error).toMatchObject({ status: "action_required", reason: "invalid_arguments" });
    expect(error["message"]).toContain("--mode fast");
  });

  it("asks for a provider before scanning", async () => {
    const result = await cli(["scan", "--json"]);
    expect(result.code).toBe(2);
    const error = parseJson(result.stderr);
    expect(error).toMatchObject({ status: "action_required", reason: "missing_provider" });
    expect(error["next"][0]["argv"].slice(0, 3)).toEqual(["kongyo-scan", "providers", "add"]);
  });

  it("reports an invalid settings file with every problem", async () => {
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ providers: [{ name: "x", base_url: "ftp://nope", model: "" }], scna: {} }),
      "utf8",
    );
    const result = await cli(["providers", "list", "--json"]);
    expect(result.code).toBe(1);
    const error = parseJson(result.stderr);
    expect(error["reason"]).toBe("invalid_config");
    const fields = error["data"]["issues"].map((issue: { field: string }) => issue.field);
    expect(fields).toEqual(
      expect.arrayContaining(["providers[0].base_url", "providers[0].model", "scna"]),
    );
  });
});

describe("providers", () => {
  let upstream: FakeUpstream;

  beforeAll(async () => {
    upstream = await fakeUpstream((request, response) => {
      if (request.headers.authorization !== `Bearer ${SECRET}`) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Invalid API key." } }));
        return;
      }
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "model-b" }, { id: "model-a" }] }));
        return;
      }
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Not found." } }));
        return;
      }
      const tools = request.body["tools"] as { function: { name: string } }[];
      sendSse(
        response,
        [
          [
            undefined,
            chatChunk({
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: tools[0]!.function.name, arguments: '{"status":"ok"}' },
                },
              ],
            }),
          ],
          [undefined, chatChunk({}, "tool_calls")],
          [
            undefined,
            {
              id: "chatcmpl-1",
              choices: [],
              usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
            },
          ],
        ],
        true,
      );
    });
  });
  afterAll(async () => {
    await upstream.close();
  });

  async function addProvider(name = "local", extra: readonly string[] = []) {
    return await cli(
      [
        "providers",
        "add",
        name,
        "--base-url",
        upstream.baseUrl,
        "--model",
        "model-a",
        "--api-key-stdin",
        "--json",
        ...extra,
      ],
      { stdin: `${SECRET}\n` },
    );
  }

  it("lists nothing as an empty table", async () => {
    const result = await cli(["providers", "list"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("#\tName\tModel\tAPI\tKey\tStatus\n");
    expect(result.stderr).toContain("No providers configured.");
    expect(parseJson((await cli(["providers", "list", "--json"])).stdout)).toEqual({
      providers: [],
      pagination: { next: null },
    });
  });

  it("checks a new endpoint, detects its API, and keeps the key out of the settings file", async () => {
    const added = await addProvider();
    expect(added.stderr).toBe("");
    expect(added.code).toBe(0);
    const document = parseJson(added.stdout);
    expect(document["outcome"]).toBe("added");
    expect(document["provider"]).toMatchObject({
      name: "local",
      position: 1,
      wireApi: "chat",
      model: "model-a",
      key: { source: "stored", env: null },
    });
    expect(document["check"]).toMatchObject({ ok: true, toolCall: true, wireApi: "chat" });
    expect(added.stdout).not.toContain(SECRET);

    const settings = await readFile(join(home, "config.json"), "utf8");
    expect(settings).not.toContain(SECRET);
    expect(JSON.parse(settings)).toEqual({
      providers: [
        { name: "local", base_url: upstream.baseUrl, model: "model-a", wire_api: "chat" },
      ],
    });
    const credentials = join(home, "state", "codex-home", "kongyo-scan-credentials.json");
    expect(await readFile(credentials, "utf8")).toContain(SECRET);
    if (process.platform !== "win32") {
      expect((await stat(credentials)).mode & 0o777).toBe(0o600);
      expect((await stat(join(home, "config.json"))).mode & 0o777).toBe(0o600);
    }

    const listed = await cli(["providers", "list"]);
    expect(listed.stdout).toBe(
      "#\tName\tModel\tAPI\tKey\tStatus\n1\tlocal\tmodel-a\tchat\tstored ****CRET\tprimary\n",
    );
    const shown = await cli(["config", "list"]);
    expect(shown.stdout).not.toContain(SECRET);
    expect(shown.stdout).toContain("providers.local.api_key\t****CRET");
    expect((await cli(["config", "get", "providers.local.api_key"])).stdout).toBe("****CRET\n");
  });

  it("never shows a credential kept in a header or query parameter", async () => {
    await addProvider("local", [
      "--header",
      "X-Api-Key=header-0123456789SECRET,x-trace={session_id}",
    ]);
    const settings = join(home, "config.json");
    const config = JSON.parse(await readFile(settings, "utf8")) as {
      providers: Record<string, unknown>[];
    };
    config.providers[0]!["query_params"] = { key: "query-0123456789SECRET", "api-version": "1" };
    await writeFile(settings, JSON.stringify(config), "utf8");

    const leaked = (text: string): boolean => /0123456789SECRET/u.test(text);
    const headers = await cli(["config", "get", "providers.local.headers"]);
    expect(headers.stdout).toBe('{"X-Api-Key":"****CRET","x-trace":"{session_id}"}\n');
    const asJson = await cli(["config", "get", "providers.local.headers", "--json"]);
    expect(parseJson(asJson.stdout)["setting"]["value"]).toEqual({
      "X-Api-Key": "****CRET",
      "x-trace": "{session_id}",
    });
    const whole = await cli(["config", "get", "providers.local"]);
    const listed = await cli(["config", "list"]);
    const listedJson = await cli(["config", "list", "--json"]);
    for (const result of [headers, asJson, whole, listed, listedJson]) {
      expect(result.code).toBe(0);
      expect(leaked(result.stdout + result.stderr)).toBe(false);
    }
    expect(listed.stdout).toContain("providers.local.query_params.key\t****CRET");
    expect(listed.stdout).toContain("providers.local.query_params.api-version\t1");
    expect((await cli(["config", "get", "providers.local.query_params.key"])).stdout).toBe(
      "****CRET\n",
    );
  });

  it("never hands a key stored under a name to a new provider with that name", async () => {
    await addProvider("reused");
    const credentials = join(home, "state", "codex-home", "kongyo-scan-credentials.json");
    expect(await readFile(credentials, "utf8")).toContain(SECRET);
    await writeFile(join(home, "config.json"), "{}", "utf8");

    const other = await fakeUpstream((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Invalid API key." } }));
    });
    try {
      const checked = await cli([
        "providers",
        "add",
        "reused",
        "--base-url",
        other.baseUrl,
        "--model",
        "m",
        "--wire-api",
        "chat",
        "--json",
      ]);
      expect(checked.code).toBe(1);
      expect(other.requests).toHaveLength(1);
      expect(other.requests[0]!.headers["authorization"]).toBeUndefined();

      const added = await cli([
        "providers",
        "add",
        "reused",
        "--base-url",
        other.baseUrl,
        "--model",
        "m",
        "--wire-api",
        "chat",
        "--no-check",
        "--json",
      ]);
      expect(parseJson(added.stdout)["provider"]["key"]).toEqual({ source: "none", env: null });
      expect(await readFile(credentials, "utf8")).not.toContain(SECRET);
    } finally {
      await other.close();
    }

    await addProvider("temporary");
    expect(await readFile(credentials, "utf8")).toContain(SECRET);
    expect(
      parseJson((await cli(["config", "unset", "providers.temporary", "--json"])).stdout)[
        "outcome"
      ],
    ).toBe("unset");
    expect(await readFile(credentials, "utf8")).not.toContain(SECRET);
  });

  it("saves nothing when the check fails", async () => {
    const result = await cli(
      [
        "providers",
        "add",
        "bad",
        "--base-url",
        upstream.baseUrl,
        "--model",
        "model-a",
        "--api-key-stdin",
        "--json",
      ],
      { stdin: "wrong-key\n" },
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const error = parseJson(result.stderr);
    expect(error).toMatchObject({ status: "error", reason: "invalid_credentials" });
    expect(result.stderr).not.toContain("wrong-key");
    expect(parseJson((await cli(["providers", "list", "--json"])).stdout)["providers"]).toEqual([]);
  });

  it("manages order, state, and removal", async () => {
    await addProvider("one");
    await addProvider("two", ["--no-check", "--wire-api", "responses"]);
    const duplicate = await addProvider("ONE");
    expect(duplicate.code).toBe(1);
    expect(parseJson(duplicate.stderr)["reason"]).toBe("provider_exists");

    const moved = parseJson((await cli(["providers", "move", "two", "--first", "--json"])).stdout);
    expect(moved).toMatchObject({ outcome: "moved", order: ["two", "one"] });
    expect(
      parseJson((await cli(["providers", "move", "two", "--position", "1", "--json"])).stdout)[
        "outcome"
      ],
    ).toBe("unchanged");
    expect((await cli(["providers", "move", "two"])).code).toBe(2);
    expect((await cli(["providers", "move", "two", "--position", "9"])).code).toBe(2);

    expect(
      parseJson((await cli(["providers", "disable", "two", "--json"])).stdout)["outcome"],
    ).toBe("disabled");
    expect(
      parseJson((await cli(["providers", "disable", "two", "--json"])).stdout)["outcome"],
    ).toBe("unchanged");
    const listed = await cli(["providers", "list"]);
    expect(
      listed.stdout
        .split("\n")
        .slice(1, 3)
        .map((line) => line.split("\t").at(-1)),
    ).toEqual(["disabled", "primary"]);
    expect(parseJson((await cli(["providers", "enable", "two", "--json"])).stdout)["outcome"]).toBe(
      "enabled",
    );

    const renamed = await cli([
      "providers",
      "update",
      "one",
      "--name",
      "main",
      "--model",
      "model-b",
      "--effort",
      "max",
    ]);
    expect(renamed.code).toBe(0);
    expect(renamed.stdout).toBe("main\n");
    expect(renamed.stderr).toContain("Updated main");
    expect((await cli(["config", "get", "providers.main.api_key"])).stdout).toBe("****CRET\n");
    expect((await cli(["config", "get", "providers.main.reasoning_effort"])).stdout).toBe("max\n");
    expect((await cli(["providers", "update", "main"])).code).toBe(2);

    const removed = parseJson((await cli(["providers", "remove", "main", "--json"])).stdout);
    expect(removed).toMatchObject({ outcome: "removed", keyDeleted: true, remaining: 1 });
    const missing = await cli(["providers", "remove", "main", "--json"]);
    expect(missing.code).toBe(1);
    expect(parseJson(missing.stderr)).toMatchObject({
      reason: "provider_not_found",
      data: { providers: ["two"] },
    });
  });

  it("checks providers and lists their models", async () => {
    await addProvider("good");
    await cli([
      "providers",
      "add",
      "dead",
      "--base-url",
      "http://127.0.0.1:9/v1",
      "--model",
      "m",
      "--wire-api",
      "chat",
      "--no-check",
      "--api-key-env",
      "UNSET_KEY_VARIABLE",
    ]);

    const check = await cli(["providers", "check", "--json"]);
    expect(check.code).toBe(1);
    const report = parseJson(check.stdout);
    expect(report["summary"]).toEqual({ succeeded: 1, failed: 1 });
    expect(report["results"][0]).toMatchObject({ provider: "good", ok: true, toolCall: true });
    expect(report["results"][1]).toMatchObject({
      provider: "dead",
      ok: false,
      error: { kind: "network" },
    });

    const one = await cli(["providers", "check", "good"]);
    expect(one.code).toBe(0);
    expect(one.stdout.split("\n")[1]!.split("\t").slice(0, 5)).toEqual([
      "good",
      "model-a",
      "chat",
      "ok",
      "yes",
    ]);

    const models = await cli(["providers", "models", "good"]);
    expect(models.stdout).toBe("model-a\nmodel-b\n");
    expect(parseJson((await cli(["providers", "models", "--json"])).stdout)["models"]).toEqual([
      { id: "model-a", current: true },
      { id: "model-b", current: false },
    ]);
  });

  it("tests with the effort a scan would send and says how to change it", async () => {
    const picky = await fakeUpstream((request, response) => {
      const effort = request.body["reasoning_effort"];
      if (effort !== undefined && effort !== "high") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: `reasoning_effort ${String(effort)} is not supported` },
          }),
        );
        return;
      }
      const tools = request.body["tools"] as { function: { name: string } }[];
      sendSse(
        response,
        [
          [
            undefined,
            chatChunk({
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: tools[0]!.function.name, arguments: '{"status":"ok"}' },
                },
              ],
            }),
          ],
          [undefined, chatChunk({}, "tool_calls")],
        ],
        true,
      );
    });
    try {
      const base = ["providers", "add", "picky", "--base-url", picky.baseUrl, "--model", "m"];
      const rejected = await cli([...base, "--wire-api", "chat"]);
      expect(rejected.code).toBe(1);
      const message = rejected.stderr.replaceAll(/\s+/gu, " ");
      expect(message).toContain("reasoning_effort xhigh is not supported");
      expect(message).toContain(
        "If it does not accept reasoning effort xhigh, pass --effort with a value it accepts, or --effort default to send none.",
      );
      expect(parseJson((await cli(["providers", "list", "--json"])).stdout)["providers"]).toEqual(
        [],
      );

      const accepted = await cli([...base, "--wire-api", "chat", "--effort", "high", "--json"]);
      expect(accepted.code).toBe(0);
      expect(parseJson(accepted.stdout)["provider"]).toMatchObject({ reasoningEffort: "high" });
      expect((await cli(["providers", "check", "--json"])).code).toBe(0);

      await cli(["providers", "update", "picky", "--effort", "default"]);
      expect((await cli(["providers", "check", "--json"])).code).toBe(0);
      expect(picky.requests.at(-1)!.body).not.toHaveProperty("reasoning_effort");
    } finally {
      await picky.close();
    }
  });

  it("uses a provider defined by environment variables first", async () => {
    await addProvider("saved");
    const result = await cli(["providers", "list", "--json"], {
      env: {
        KONGYO_SCAN_BASE_URL: upstream.baseUrl,
        KONGYO_SCAN_MODEL: "model-b",
        KONGYO_SCAN_API_KEY: SECRET,
      },
    });
    const providers = parseJson(result.stdout)["providers"];
    expect(providers.map((provider: { name: string }) => provider.name)).toEqual(["env", "saved"]);
    expect(providers[0]["key"]).toEqual({ source: "environment", env: "KONGYO_SCAN_API_KEY" });
  });
});

describe("settings", () => {
  it("sets, reads, and removes values", async () => {
    const set = await cli(["config", "set", "policy.fail_on_severity", "high"]);
    expect(set).toMatchObject({ code: 0, stdout: "policy.fail_on_severity\n" });
    expect((await cli(["config", "set", "scan.deep.workers", "2", "--json"])).code).toBe(0);
    expect((await cli(["config", "set", "codex.analytics.enabled", "false"])).code).toBe(0);
    expect((await cli(["config", "get", "scan.deep.workers"])).stdout).toBe("2\n");
    expect(JSON.parse(await readFile(join(home, "config.json"), "utf8"))).toEqual({
      policy: { fail_on_severity: "high" },
      scan: { deep: { workers: 2 } },
      codex: { analytics: { enabled: false } },
    });

    const invalid = await cli(["config", "set", "policy.fail_on_severity", "severe", "--json"]);
    expect(invalid.code).toBe(2);
    expect(parseJson(invalid.stderr)["message"]).toContain("policy.fail_on_severity");
    const unknown = await cli(["config", "set", "scan.moed", "deep"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr.replaceAll(/\s+/gu, " ")).toContain(
      "scan.moed is not a known setting. Did you mean scan.mode?",
    );
    expect(unknown.stderr).toContain("    kongyo-scan config set scan.mode deep\n");

    expect(
      parseJson((await cli(["config", "unset", "scan.deep.workers", "--json"])).stdout)["outcome"],
    ).toBe("unset");
    expect(
      parseJson((await cli(["config", "unset", "scan.deep.workers", "--json"])).stdout)["outcome"],
    ).toBe("unchanged");
    const missing = await cli(["config", "get", "scan.deep.workers"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("scan.deep.workers is not set.");
  });

  it("documents every setting and locates the file", async () => {
    const keys = parseJson((await cli(["config", "keys", "--json"])).stdout)["settings"];
    const names = keys.map((setting: { key: string }) => setting.key);
    expect(names).toEqual(
      expect.arrayContaining([
        "reasoning_effort",
        "scan.mode",
        "policy.fail_on_severity",
        "gateway.cooldown_seconds",
      ]),
    );
    expect((await cli(["config", "path"])).stdout).toBe(`${join(home, "config.json")}\n`);
    const other = await mkdtemp(join(tmpdir(), "kscan-other-"));
    try {
      expect((await cli(["config", "path", "--home", other])).stdout).toBe(
        `${join(other, "config.json")}\n`,
      );
      expect((await cli(["--home", other, "config", "path"])).stdout).toBe(
        `${join(other, "config.json")}\n`,
      );
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("creates a starter file once", async () => {
    const created = await cli(["init"]);
    expect(created.code).toBe(0);
    const file = join(work, "kongyo-scan.json");
    expect(created.stdout).toBe(`${file}\n`);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      scan: { mode: "standard" },
      policy: { fail_on_severity: "high" },
    });
    const again = await cli(["init", "--json"]);
    expect(again.code).toBe(1);
    expect(parseJson(again.stderr)["reason"]).toBe("file_exists");
    expect(parseJson((await cli(["init", "--force", "--json"])).stdout)["outcome"]).toBe(
      "replaced",
    );
  });
});

describe("scans", () => {
  const SCAN_ID = "11111111-2222-4333-8444-555555555555";

  async function seedScan(): Promise<string> {
    const scanDir = join(home, "state", "scans", "demo");
    await mkdir(join(scanDir, "exports"), { recursive: true });
    await writeFile(
      join(scanDir, "findings.json"),
      JSON.stringify({
        findings: [
          {
            findingId: "f1",
            title: "=SQL injection",
            severity: { level: "high" },
            locations: [{ path: "src/a.js", startLine: 3 }],
            summary: 'Uses "raw" input.',
            remediation: "Use parameters.",
          },
        ],
      }),
      "utf8",
    );
    await writeFile(join(scanDir, "report.md"), "# Report\n\nOne finding.\n", "utf8");
    await writeFile(
      join(scanDir, "exports", "results.sarif"),
      '{"version":"2.1.0","runs":[]}\n',
      "utf8",
    );
    const record = {
      scanId: SCAN_ID,
      status: "completed",
      repository: work,
      target: { kind: "paths", paths: ["src"] },
      mode: "standard",
      startedAt: "2026-01-02T03:04:05.000Z",
      finishedAt: "2026-01-02T03:06:05.000Z",
      durationMs: 120_000,
      scanDir,
      reportPath: join(scanDir, "report.md"),
      sarifPath: join(scanDir, "exports", "results.sarif"),
      findings: { critical: 0, high: 1, medium: 0, low: 0, informational: 0 },
      findingCount: 1,
      providers: ["local"],
      model: "model-a",
      effort: "max",
    };
    const failed = {
      ...record,
      scanId: "99999999-2222-4333-8444-555555555555",
      status: "failed",
      startedAt: "2026-01-03T00:00:00.000Z",
      error: "All providers failed.",
    };
    await writeFile(
      join(home, "history.jsonl"),
      `${JSON.stringify(record)}\n${JSON.stringify(failed)}\n`,
      "utf8",
    );
    return scanDir;
  }

  it("says so when there are none", async () => {
    const empty = await cli(["scans", "list"]);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toBe("Age\tScan ID\tStatus\tFindings\tScope\tRepository\n");
    expect(empty.stderr).toContain("No scans yet.");
    const inspect = await cli(["scans", "inspect", "--json"]);
    expect(inspect.code).toBe(1);
    expect(parseJson(inspect.stderr)["reason"]).toBe("scan_not_found");
  });

  it("lists, inspects, and exports saved scans", async () => {
    const scanDir = await seedScan();
    const listed = await cli(["scans", "list"]);
    const rows = listed.stdout
      .trim()
      .split("\n")
      .map((line) => line.split("\t"));
    expect(rows[1]!.slice(1, 4)).toEqual(["99999999-2222-4333-8444-555555555555", "failed", "-"]);
    expect(rows[2]!.slice(1, 5)).toEqual([SCAN_ID, "completed", "1 high", "src"]);
    expect(
      parseJson((await cli(["scans", "list", "--limit", "1", "--json"])).stdout),
    ).toMatchObject({ total: 2, scans: [{ status: "failed" }] });
    expect(
      parseJson((await cli(["scans", "list", "--repository", "/nowhere", "--json"])).stdout)[
        "scans"
      ],
    ).toEqual([]);

    const inspected = parseJson((await cli(["scans", "inspect", "--json"])).stdout);
    expect(inspected["scan"]).toMatchObject({ id: SCAN_ID, findingCount: 1, scanDir });
    expect(inspected["findings"][0]).toMatchObject({
      title: "=SQL injection",
      severity: "high",
      path: "src/a.js",
      startLine: 3,
    });
    const human = await cli(["scans", "inspect", "1111"]);
    expect(human.stdout).toContain("1. =SQL injection");
    expect(human.stdout).toContain("high  ·  src/a.js:3");
    expect(human.stderr).toContain(`Scan ID: ${SCAN_ID}`);

    expect((await cli(["scans", "report", "1111"])).stdout).toBe("# Report\n\nOne finding.\n");
    expect((await cli(["scans", "export", "1111"])).stdout).toBe('{"version":"2.1.0","runs":[]}\n');
    const csv = await cli(["scans", "export", "1111", "--format", "csv"]);
    expect(csv.stdout).toBe(
      'severity,confidence,title,path,start_line,end_line,category,cwe,summary,remediation\r\n"high","","\'=SQL injection","src/a.js","3","","","","Uses ""raw"" input.","Use parameters."\r\n',
    );

    const saved = await cli([
      "scans",
      "export",
      "1111",
      "--format",
      "markdown",
      "--output",
      "out.md",
      "--json",
    ]);
    expect(parseJson(saved.stdout)).toMatchObject({
      outcome: "exported",
      export: { format: "markdown", path: join(work, "out.md") },
    });
    expect(await readFile(join(work, "out.md"), "utf8")).toBe("# Report\n\nOne finding.\n");
    const clash = await cli([
      "scans",
      "export",
      "1111",
      "--format",
      "markdown",
      "--output",
      "out.md",
    ]);
    expect(clash.code).toBe(1);
    expect(clash.stderr).toContain("already exists");
    expect(
      (
        await cli([
          "scans",
          "export",
          "1111",
          "--format",
          "markdown",
          "--output",
          "out.md",
          "--force",
        ])
      ).code,
    ).toBe(0);

    const unsealed = await cli(["scans", "export", "9999", "--json"]);
    expect(unsealed.code).toBe(1);
    expect(parseJson(unsealed.stderr)["reason"]).toBe("conflict");
    expect((await cli(["scans", "export", "1111", "--format", "pdf"])).code).toBe(2);
    expect((await cli(["scans", "inspect", "zzzz"])).code).toBe(1);
  });
});

describe("scan planning", () => {
  it("validates a scan without starting it", async () => {
    execFileSync("git", ["init", "--quiet", work]);
    await mkdir(join(work, "src"));
    await writeFile(join(work, "src", "index.js"), "console.log(1);\n", "utf8");
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        providers: [
          {
            name: "first",
            base_url: "http://127.0.0.1:9/v1",
            model: "model-a",
            wire_api: "responses",
            api_key_env: "FIRST_KEY",
          },
          { name: "second", base_url: "http://127.0.0.1:9/v2", model: "model-b" },
        ],
        reasoning_effort: "max",
      }),
      "utf8",
    );
    await writeFile(
      join(work, "team.json"),
      JSON.stringify({
        scan: { scope: { paths: ["src"] } },
        policy: { fail_on_severity: "medium" },
      }),
      "utf8",
    );

    const result = await cli(
      ["scan", "--dry-run", "--json", "--config", "team.json", "--provider", "second,first"],
      { env: { FIRST_KEY: "k" } },
    );
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const document = parseJson(result.stdout);
    expect(document["outcome"]).toBe("planned");
    expect(document["scan"]).toMatchObject({
      target: { kind: "paths", paths: ["src"] },
      mode: "standard",
      effort: "max",
      failOnSeverity: "medium",
      providers: [
        { name: "second", model: "model-b", wireApi: "chat", keySource: null },
        {
          name: "first",
          model: "model-a",
          wireApi: "responses",
          keySource: "environment variable FIRST_KEY",
        },
      ],
    });

    const human = await cli(["scan", "--dry-run", "--path", "src", "--no-fallback"], {
      env: { FIRST_KEY: "k" },
    });
    expect(human.code).toBe(0);
    expect(human.stdout).toBe("");
    expect(human.stderr).toContain("Provider: first (model-a)");
    expect(human.stderr).toContain("The inputs are valid. Nothing was started.");

    const missing = await cli(["scan", "--dry-run", "--config", "nope.json", "--json"]);
    expect(missing.code).toBe(1);
    expect(parseJson(missing.stderr)["reason"]).toBe("not_found");

    const literal = await cli(["scan", "--dry-run", "--json", "--", work], { cwd: home });
    expect(literal.code).toBe(0);
    expect([work, await realpath(work)]).toContain(parseJson(literal.stdout)["scan"]["repository"]);
  }, 120_000);
});

describe.skipIf(process.platform === "win32")("sandbox", () => {
  const DENIED = "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted";
  const HELP = "https://github.com/kongyo2/kongyo-scan#linux-sandbox";
  const linux = process.platform === "linux";
  let tools: string;

  beforeEach(async () => {
    tools = await mkdtemp(join(tmpdir(), "kscan-tools-"));
  });
  afterEach(async () => {
    await rm(tools, { recursive: true, force: true });
  });

  /** A Codex whose sandbox works, or fails as Bubblewrap does when it may not use user namespaces. */
  async function fakeCodex(sandbox: "works" | "denied"): Promise<string> {
    const file = join(tools, `codex-${sandbox}`);
    await writeFile(
      file,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$CODEX_HOME" "$*" >> '${join(tools, "calls.log")}'`,
        'for argument in "$@"; do',
        '  if [ "$argument" = sandbox ]; then',
        sandbox === "works" ? "    exit 0" : `    echo '${DENIED}' >&2; exit 1`,
        "  fi",
        "done",
        "echo codex-cli 0.0.0-test",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(file, 0o755);
    return file;
  }

  async function configureProvider(): Promise<void> {
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        providers: [
          {
            name: "first",
            base_url: "http://127.0.0.1:9/v1",
            model: "model-a",
            wire_api: "responses",
          },
        ],
      }),
      "utf8",
    );
  }

  it("says why a scan cannot start and where the fix is", async () => {
    execFileSync("git", ["init", "--quiet", work]);
    await writeFile(join(work, "index.js"), "console.log(1);\n", "utf8");
    await configureProvider();
    const env = { CODEX_CLI_PATH: await fakeCodex("denied") };

    const json = await cli(["scan", "--json"], { env });
    expect(json.code).toBe(1);
    expect(json.stdout).toBe("");
    const error = parseJson(json.stderr);
    expect(error).toMatchObject({ status: "error", reason: "unsupported_runtime" });
    expect(error["message"]).toMatch(/^Can't start the scan\. The command sandbox /u);
    expect(error["next"]).toEqual([
      { command: "kongyo-scan doctor", argv: ["kongyo-scan", "doctor"] },
    ]);
    expect(error["data"]["sandbox"]["diagnostic"]).toBe(DENIED);
    if (linux) {
      expect(error["message"]).toContain("can't create user namespaces");
      expect(error["data"]["sandbox"]["cause"]).toBe("user_namespaces");
      expect(error["data"]["sandbox"]["fix"]).toContain(HELP);
    }

    const human = await cli(["scan"], { env });
    expect(human.code).toBe(1);
    expect(human.stdout).toBe("");
    expect(human.stderr).toContain(`\n  ${DENIED}\n`);
    expect(human.stderr).toContain("  Check the sandbox again:\n    kongyo-scan doctor\n");
    if (linux) expect(human.stderr).toContain(HELP);
    // The SDK's own advice is about its container image.
    expect(human.stderr).not.toMatch(/Compose|container image|To reproduce/u);
  }, 120_000);

  it("checks the sandbox in doctor the way a scan does", async () => {
    await configureProvider();
    const sandboxCheck = (text: string): Record<string, string> =>
      parseJson(text)["checks"].find((check: { name: string }) => check.name === "Sandbox");

    const denied = await fakeCodex("denied");
    const failing = await cli(["doctor", "--json"], { env: { CODEX_CLI_PATH: denied } });
    expect(failing.code).toBe(1);
    expect(failing.stderr).toBe("");
    const failed = sandboxCheck(failing.stdout);
    expect(failed["status"]).toBe("failed");
    expect(failed["detail"]).toContain(DENIED);
    if (linux) {
      expect(failed["detail"]).toBe(`can't create user namespaces: ${DENIED}`);
      expect(failed["fix"]).toContain(HELP);
    }
    expect(await readFile(join(tools, "calls.log"), "utf8")).toContain(
      `${join(home, "state", "codex-home")}\nsandbox -- ${denied} --version\n`,
    );

    const human = await cli(["doctor"], { env: { CODEX_CLI_PATH: denied } });
    expect(human.code).toBe(1);
    expect(human.stdout).toContain(`Sandbox\tfailed\t`);
    expect(human.stderr).toMatch(/^Error: \d of \d+ checks failed\.$/mu);
    if (linux) expect(human.stderr).toMatch(/^Sandbox: .*#linux-sandbox$/mu);

    const working = await cli(["doctor", "--json"], {
      env: { CODEX_CLI_PATH: await fakeCodex("works") },
    });
    expect(sandboxCheck(working.stdout)["status"]).toBe("ok");
  }, 120_000);
});
