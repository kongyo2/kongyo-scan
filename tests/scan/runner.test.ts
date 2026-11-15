import { describe, expect, it } from "vitest";

import type { Config } from "../../src/config/schema.js";
import { resolveScanPlan, type ScanCliOptions } from "../../src/scan/plan.js";
import { codexOverrides, GATEWAY_PROVIDER_ID, GATEWAY_TOKEN_ENV } from "../../src/scan/runner.js";

const PROVIDERS: Config["providers"] = [
  { name: "first", base_url: "https://one.example/v1", model: "model-a", timeout_seconds: 60 },
  { name: "second", base_url: "https://two.example/v1", model: "model-b" },
];
const GATEWAY_URL = "http://127.0.0.1:4000/v1";

function overrides(config: Config, cli: ScanCliOptions = {}): Record<string, unknown> {
  const plan = resolveScanPlan({ cli, config, cwd: "/work/repo", env: {}, keys: {} });
  return codexOverrides(plan, GATEWAY_URL);
}

function gatewayProvider(config: Config): unknown {
  return (overrides(config)["model_providers"] as Record<string, unknown>)[GATEWAY_PROVIDER_ID];
}

describe("codexOverrides", () => {
  it("points Codex at the gateway with the first provider's model", () => {
    expect(overrides({ providers: PROVIDERS })).toMatchObject({
      model: "model-a",
      model_reasoning_effort: "xhigh",
      model_provider: GATEWAY_PROVIDER_ID,
    });
    expect(gatewayProvider({ providers: PROVIDERS })).toEqual({
      name: "kongyo-scan",
      base_url: GATEWAY_URL,
      env_key: GATEWAY_TOKEN_ENV,
      wire_api: "responses",
      request_max_retries: 5,
      stream_max_retries: 5,
      stream_idle_timeout_ms: (60 + 180 + 300 + 30) * 1000,
    });
  });

  it("applies the retry setting to the limit Codex counts a failed chain against", () => {
    expect(
      gatewayProvider({ providers: PROVIDERS, gateway: { max_request_retries: 2 } }),
    ).toMatchObject({ request_max_retries: 2, stream_max_retries: 2 });
  });

  it("sends a concrete effort to Codex when the model's own default is asked for", () => {
    expect(overrides({ providers: PROVIDERS }, { effort: "default" })).toMatchObject({
      model_reasoning_effort: "medium",
    });
  });

  it("tells Codex the smallest context window only when every provider has one", () => {
    expect(overrides({ providers: PROVIDERS })).not.toHaveProperty("model_context_window");
    const sized = PROVIDERS!.map((provider, index) => ({
      ...provider,
      context_window: 200_000 - index * 72_000,
    }));
    expect(overrides({ providers: sized })).toMatchObject({ model_context_window: 128_000 });
  });
});
