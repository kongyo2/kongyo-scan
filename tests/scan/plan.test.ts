import { describe, expect, it } from "vitest";

import type { Config } from "../../src/config/schema.js";
import { CliError } from "../../src/core/errors.js";
import {
  anchorConfigPaths,
  mergeConfig,
  parseCodexAssignments,
  resolveScanPlan,
  type ScanCliOptions,
} from "../../src/scan/plan.js";

const CONFIG: Config = {
  providers: [
    {
      name: "first",
      base_url: "https://one.example/v1/",
      model: "model-a",
      wire_api: "responses",
      api_key_env: "FIRST_KEY",
    },
    { name: "second", base_url: "https://two.example/v1", model: "model-b" },
    { name: "parked", base_url: "https://three.example/v1", model: "model-c", disabled: true },
  ],
};

function plan(
  cli: ScanCliOptions = {},
  config: Config = CONFIG,
  env: Record<string, string> = { FIRST_KEY: "k1" },
) {
  return resolveScanPlan({ cli, config, cwd: "/work/repo", env, keys: { second: "k2" } });
}

function failure(run: () => unknown): CliError {
  try {
    run();
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected a CliError");
}

describe("resolveScanPlan", () => {
  it("uses every enabled provider in configured order, with defaults", () => {
    const result = plan();
    expect(result.repository).toBe("/work/repo");
    expect(result.target).toEqual({ kind: "repository" });
    expect(result.mode).toBe("standard");
    expect(result.effort).toBe("xhigh");
    expect(result.chain.map((provider) => provider.name)).toEqual(["first", "second"]);
    expect(result.chain[0]).toMatchObject({
      baseUrl: "https://one.example/v1",
      wireApi: "responses",
      apiKey: "k1",
    });
    expect(result.chain[1]).toMatchObject({
      wireApi: "chat",
      apiKey: "k2",
      apiKeySource: "stored key",
    });
    expect(result.gateway).toEqual({
      port: 0,
      cooldownMs: 60_000,
      idleTimeoutMs: 300_000,
      maxRequestRetries: 3,
    });
  });

  it("lets the command line pick providers, their order, and the first model", () => {
    const result = plan({ providers: ["parked", "FIRST"], model: "override" });
    expect(result.chain.map((provider) => `${provider.name}:${provider.model}`)).toEqual([
      "parked:override",
      "first:model-a",
    ]);
    expect(plan({ fallback: false }).chain.map((provider) => provider.name)).toEqual(["first"]);
  });

  it("reports an unknown provider with the configured names", () => {
    const error = failure(() => plan({ providers: ["nope"] }));
    expect(error.errorClass).toBe("not_found");
    expect(error.data).toEqual({ providers: ["first", "second", "parked"] });
    expect(failure(() => plan({ providers: ["first", "first"] })).message).toContain("twice");
  });

  it("needs a provider before it does anything", () => {
    const error = failure(() => plan({}, {}, {}));
    expect(error.errorClass).toBe("missing_input");
    expect(error.reason).toBe("missing_provider");
  });

  it("puts the environment-defined provider first", () => {
    const result = plan({}, CONFIG, {
      KONGYO_SCAN_BASE_URL: "https://env.example/v1",
      KONGYO_SCAN_MODEL: "env-model",
      KONGYO_SCAN_API_KEY: "env-key",
      KONGYO_SCAN_WIRE_API: "responses",
    });
    expect(result.chain.map((provider) => provider.name)).toEqual(["env", "first", "second"]);
    expect(result.chain[0]).toMatchObject({
      model: "env-model",
      apiKey: "env-key",
      wireApi: "responses",
    });
    expect(failure(() => plan({}, CONFIG, { KONGYO_SCAN_MODEL: "only" })).message).toContain(
      "KONGYO_SCAN_BASE_URL",
    );
  });

  it("resolves one scope and rejects combinations", () => {
    expect(plan({ paths: ["src", "lib/a.ts"] }).target).toEqual({
      kind: "paths",
      paths: ["src", "lib/a.ts"],
    });
    expect(plan({ diff: "main", head: "feature" }).target).toEqual({
      kind: "diff",
      base: "main",
      head: "feature",
    });
    expect(plan({ workingTree: true, base: "main" }).target).toEqual({
      kind: "working_tree",
      base: "main",
    });
    expect(failure(() => plan({ paths: ["src"], diff: "main" })).message).toBe(
      "Can't use --path with --diff. Choose one scope.",
    );
    expect(failure(() => plan({ head: "x" })).message).toBe("Can't use --head without --diff.");
    expect(failure(() => plan({ base: "x" })).message).toBe(
      "Can't use --base without --working-tree.",
    );
    expect(failure(() => plan({ paths: ["../outside"] })).message).toContain("stay inside it");
    expect(failure(() => plan({ paths: ["/etc"] })).message).toContain("stay inside it");
  });

  it("takes the scope from settings unless the command line gives one", () => {
    const config: Config = { ...CONFIG, scan: { scope: { diff: { base: "main" } } } };
    expect(plan({}, config).target).toEqual({ kind: "diff", base: "main" });
    expect(plan({ head: "topic" }, config).target).toEqual({
      kind: "diff",
      base: "main",
      head: "topic",
    });
    expect(plan({ paths: ["src"] }, config).target).toEqual({ kind: "paths", paths: ["src"] });
  });

  it("keeps deep-scan options to deep scans", () => {
    const deep = plan({ mode: "deep", workers: 2, subagents: 0, maxDiscoveryRuns: 5 });
    expect(deep.mode).toBe("deep");
    expect(deep.deep).toMatchObject({ workers: 2, subagents: 0, maxDiscoveryRuns: 5 });
    expect(failure(() => plan({ workers: 2 })).message).toBe(
      "Can't use --workers without --mode deep.",
    );
    expect(failure(() => plan({ mode: "deep", workers: 0 })).message).toContain("positive integer");
    expect(failure(() => plan({ mode: "deep", diff: "main" })).message).toContain(
      "deep scan on a diff",
    );
    expect(failure(() => plan({ mode: "deep", validationPromptFile: "v.md" })).message).toContain(
      "standard scans only",
    );
    expect(failure(() => plan({ mode: "fast" })).message).toBe(
      "Can't use --mode fast. Use standard or deep.",
    );
  });

  it("validates limits and the failure policy", () => {
    expect(plan({ failOnSeverity: "medium" }).failOnSeverity).toBe("medium");
    expect(plan({}, { ...CONFIG, policy: { fail_on_severity: "low" } }).failOnSeverity).toBe("low");
    expect(failure(() => plan({ failOnSeverity: "severe" })).message).toContain(
      "critical, high, medium, or low",
    );
    expect(failure(() => plan({ maxTime: 0 })).message).toContain("positive number of minutes");
    expect(failure(() => plan({ mode: "deep", maxTime: 6000 })).message).toContain("5760");
  });

  it("refuses a cost limit it can't enforce", () => {
    const error = failure(() => plan({ maxCost: 5 }));
    expect(error.message).toBe(
      "Can't enforce a cost limit. Providers first, second have no pricing.",
    );
    const priced: Config = {
      providers: CONFIG.providers!.slice(0, 2).map((provider) => ({
        ...provider,
        pricing: { input_per_mtok: 1, output_per_mtok: 4 },
      })),
    };
    const result = plan({ maxCost: 5 }, priced);
    expect(result.maxCostUsd).toBe(5);
    expect(result.chain[0]!.pricing).toEqual({
      inputPerMtok: 1,
      cachedInputPerMtok: 1,
      outputPerMtok: 4,
    });
  });

  it("resolves file options against the working directory and settings as given", () => {
    const config: Config = {
      ...CONFIG,
      scan: { instructions_file: "/settings/scan.md", knowledge_base: ["/settings/kb"] },
      output: { directory: "/settings/out" },
    };
    const fromSettings = plan({}, config);
    expect(fromSettings.scanPromptFile).toBe("/settings/scan.md");
    expect(fromSettings.knowledgeBase).toEqual(["/settings/kb"]);
    expect(fromSettings.outputDir).toBe("/settings/out");
    const fromCli = plan(
      {
        scanPromptFile: "prompts/scan.md",
        knowledgeBase: ["docs"],
        outputDir: "../out",
        python: "python3.12",
        repository: "sub",
      },
      config,
    );
    expect(fromCli.scanPromptFile).toBe("/work/repo/prompts/scan.md");
    expect(fromCli.knowledgeBase).toEqual(["/work/repo/docs"]);
    expect(fromCli.outputDir).toBe("/work/out");
    expect(fromCli.python).toBe("python3.12");
    expect(fromCli.repository).toBe("/work/repo/sub");
    expect(plan({ python: "./venv/bin/python" }).python).toBe("/work/repo/venv/bin/python");
  });

  it("merges native Codex settings and protects the ones it manages", () => {
    const config: Config = {
      ...CONFIG,
      codex: { analytics: { enabled: false }, features: { a: true } },
    };
    const result = plan(
      { codex: ["features.b=true", "sandbox_workspace_write.network_access=false"] },
      config,
    );
    expect(result.codex).toEqual({
      analytics: { enabled: false },
      features: { a: true, b: true },
      sandbox_workspace_write: { network_access: false },
    });
    expect(failure(() => plan({ codex: ["model=gpt-5"] })).message).toContain(
      "kongyo-scan manages it",
    );
    expect(
      failure(() => plan({}, { ...CONFIG, codex: { model_provider: "openai" } })).message,
    ).toContain("the codex setting");
  });
});

describe("parseCodexAssignments", () => {
  it("parses JSON values, TOML literal strings, and bare text", () => {
    expect(
      parseCodexAssignments(["a.b=1", "a.c='high'", 'd="x y"', "e=plain text", "f=[1,2]"]),
    ).toEqual({
      a: { b: 1, c: "high" },
      d: "x y",
      e: "plain text",
      f: [1, 2],
    });
  });

  it("rejects malformed, repeated, and unsafe assignments", () => {
    expect(failure(() => parseCodexAssignments(["novalue"])).message).toContain("KEY=VALUE");
    expect(failure(() => parseCodexAssignments(["a=1", "a=2"])).message).toBe(
      "Can't set --codex a twice.",
    );
    expect(failure(() => parseCodexAssignments(["a=1", "a.b=2"])).message).toContain(
      "already has a value",
    );
    expect(failure(() => parseCodexAssignments(["__proto__.x=1"])).message).toContain(
      "isn't a valid setting name",
    );
  });
});

describe("settings layers", () => {
  it("merges objects and replaces lists and scalars", () => {
    const merged = mergeConfig(
      {
        reasoning_effort: "high",
        scan: { mode: "standard", knowledge_base: ["a"], deep: { workers: 2 } },
      },
      {
        scan: { knowledge_base: ["b"], deep: { max_discovery_runs: 9 } },
        policy: { fail_on_severity: "high" },
      },
    );
    expect(merged).toEqual({
      reasoning_effort: "high",
      scan: {
        mode: "standard",
        knowledge_base: ["b"],
        deep: { workers: 2, max_discovery_runs: 9 },
      },
      policy: { fail_on_severity: "high" },
    });
  });

  it("anchors relative paths to the file that set them", () => {
    const anchored = anchorConfigPaths(
      {
        scan: {
          instructions_file: "prompts/scan.md",
          rubric_file: "/abs/rubric.md",
          knowledge_base: ["kb", "~/notes"],
        },
        output: { directory: "../out" },
        python: "python3",
      },
      "/repo/config/kongyo-scan.json",
      { HOME: "/home/someone" },
    );
    expect(anchored.scan).toEqual({
      instructions_file: "/repo/config/prompts/scan.md",
      rubric_file: "/abs/rubric.md",
      knowledge_base: ["/repo/config/kb", "/home/someone/notes"],
    });
    expect(anchored.output).toEqual({ directory: "/repo/out" });
    expect(anchored.python).toBe("python3");
  });
});
