import { z } from "zod";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

export const PROVIDER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
export const WIRE_APIS = ["responses", "chat"] as const;
export type WireApi = (typeof WIRE_APIS)[number];
export const SCAN_MODES = ["standard", "deep"] as const;
export const FAIL_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type FailSeverity = (typeof FAIL_SEVERITIES)[number];

export const EFFORT_PROVIDER_DEFAULT = "default";
export const DEFAULT_REASONING_EFFORT = "xhigh";

const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();
const nonEmpty = z.string().min(1);

const baseUrl = z
  .string()
  .min(1)
  .refine(
    (value) => {
      const url = URL.parse(value);
      return (
        url !== null &&
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.hostname !== ""
      );
    },
    { error: "must be an http(s) URL such as https://api.example.com/v1" },
  )
  .refine((value) => URL.parse(value)?.username === "" && URL.parse(value)?.password === "", {
    error: "must not embed credentials; use api_key or api_key_env",
  });

const headerName = z
  .string()
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u, { error: "must be a valid HTTP header name" });
const headerValue = z.string().regex(/^[^\r\n]*$/u, { error: "must be a single line" });

export const PricingSchema = z
  .strictObject({
    input_per_mtok: z.number().nonnegative().describe("USD per 1M uncached input tokens."),
    cached_input_per_mtok: z
      .number()
      .nonnegative()
      .optional()
      .describe("USD per 1M cached input tokens (default: the input price)."),
    output_per_mtok: z.number().nonnegative().describe("USD per 1M output tokens."),
  })
  .describe("Token prices used for cost estimates and --max-cost.");

export const CompatSchema = z
  .strictObject({
    native_responses: z
      .boolean()
      .optional()
      .describe(
        "Responses endpoints only: send requests in OpenAI's own shape, with namespaced tools, hosted tools, and agent messages unchanged (default: true for api.openai.com, false elsewhere). Other endpoints get plain function tools and plain messages.",
      ),
    images: z
      .boolean()
      .optional()
      .describe("Send image inputs to the model (default: true). Set false for text-only models."),
    omit_params: z
      .array(nonEmpty)
      .optional()
      .describe(
        "Top-level request body parameters to remove before sending, such as parallel_tool_calls.",
      ),
    extra_body: z
      .record(z.string(), jsonValue)
      .optional()
      .describe("Extra top-level request body parameters, merged last."),
  })
  .describe("Compatibility switches for endpoints that reject parts of a request.");

export const ProviderSchema = z.strictObject({
  name: z
    .string()
    .regex(PROVIDER_NAME_PATTERN, {
      error:
        "must start with a letter or digit and use only letters, digits, dots, underscores, and hyphens (64 max)",
    })
    .describe("Unique provider name."),
  base_url: baseUrl.describe(
    "Endpoint base URL up to the version segment, such as https://api.example.com/v1.",
  ),
  model: nonEmpty.describe("Model ID to request from this endpoint."),
  wire_api: z
    .enum(WIRE_APIS)
    .optional()
    .describe(
      "API the endpoint speaks: responses (POST /responses) or chat (POST /chat/completions). Default: chat.",
    ),
  api_key: nonEmpty
    .optional()
    .describe("API key stored in this file. Prefer api_key_env on shared machines."),
  api_key_env: z
    .string()
    .regex(ENV_NAME_PATTERN, { error: "must be an environment variable name" })
    .optional()
    .describe(
      "Environment variable that holds the API key. Takes precedence over api_key when set.",
    ),
  headers: z
    .record(headerName, headerValue)
    .optional()
    .describe("Extra request headers. Values may use {session_id} and {api_key}."),
  query_params: z
    .record(nonEmpty, z.string())
    .optional()
    .describe("Query parameters appended to every request."),
  reasoning_effort: nonEmpty
    .optional()
    .describe(
      'Reasoning effort for this provider, overriding the scan effort. "default" sends no effort parameter.',
    ),
  context_window: positiveInteger.optional().describe("Model context window in tokens."),
  max_output_tokens: positiveInteger
    .optional()
    .describe("Upper bound for generated tokens per request."),
  timeout_seconds: positiveInteger
    .optional()
    .describe(
      "Seconds to wait for the first response byte before trying the next provider (default: 180).",
    ),
  disabled: z
    .boolean()
    .optional()
    .describe("Keep the provider configured but leave it out of the chain."),
  pricing: PricingSchema.optional(),
  compat: CompatSchema.optional(),
});
export type ProviderConfig = z.infer<typeof ProviderSchema>;

const scopeSchema = z
  .union([
    z.strictObject({
      paths: z.array(nonEmpty).min(1).describe("Repository-relative files or directories."),
    }),
    z.strictObject({
      diff: z.strictObject({
        base: nonEmpty.describe("Base revision."),
        head: nonEmpty.optional().describe("Head revision (default: HEAD)."),
      }),
    }),
    z.strictObject({
      working_tree: z.strictObject({
        base: nonEmpty.optional().describe("Base revision (default: HEAD)."),
      }),
    }),
  ])
  .describe("Exactly one of paths, diff, or working_tree. Default: the whole repository.");
export type ScopeConfig = z.infer<typeof scopeSchema>;

export const DeepSchema = z.strictObject({
  workers: positiveInteger
    .optional()
    .describe("Maximum concurrent deep-scan discovery workers (default: 4)."),
  subagents_per_worker: nonNegativeInteger
    .optional()
    .describe("Subagents available to each deep-scan worker; zero is valid (default: 3)."),
  stop_after_no_new: positiveInteger
    .optional()
    .describe("Stop after this many runs find no new issues (default: 4)."),
  stop_after_consecutive_errors: positiveInteger
    .optional()
    .describe("Stop after this many consecutive discovery errors (default: 3)."),
  max_discovery_runs: positiveInteger
    .optional()
    .describe("Maximum deep-scan discovery runs (default: 40)."),
});

export const ScanSchema = z.strictObject({
  mode: z.enum(SCAN_MODES).optional().describe("standard or deep (default: standard)."),
  max_time_minutes: z
    .number()
    .positive()
    .optional()
    .describe(
      "Investigation minutes: advisory in standard scans, enforced discovery limit in deep scans.",
    ),
  scope: scopeSchema.optional(),
  knowledge_base: z.array(nonEmpty).optional().describe("Security-context files or directories."),
  instructions_file: nonEmpty.optional().describe("File with additional scan instructions."),
  validation_file: nonEmpty
    .optional()
    .describe("File that replaces final validation with a custom workflow (standard scans only)."),
  post_scan_file: nonEmpty.optional().describe("File with instructions to run after each scan."),
  rubric_file: nonEmpty.optional().describe("Markdown severity rubric used to grade findings."),
  owner_suggestions: z
    .boolean()
    .optional()
    .describe("Write owner-suggestions.json after a committed Git scan (default: false)."),
  deep: DeepSchema.optional(),
});

export const GatewaySchema = z
  .strictObject({
    port: z
      .number()
      .int()
      .min(0)
      .max(65535)
      .optional()
      .describe("Loopback port for the local gateway (default: 0, a free port)."),
    cooldown_seconds: nonNegativeInteger
      .optional()
      .describe("Seconds a failing provider is skipped before it is tried again (default: 60)."),
    stream_idle_timeout_seconds: positiveInteger
      .optional()
      .describe(
        "Seconds without a streamed event before a response is treated as lost (default: 300).",
      ),
    max_request_retries: nonNegativeInteger
      .optional()
      .describe(
        "Times Codex retries a model request after every provider failed, waiting longer before each try (default: 5).",
      ),
  })
  .describe("Local gateway that relays model requests to the provider chain.");

export const ConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  providers: z
    .array(ProviderSchema)
    .optional()
    .describe("Model endpoints in fallback order. The first enabled provider is tried first."),
  reasoning_effort: nonEmpty
    .optional()
    .describe(
      `Reasoning effort for scans, passed through to the model (default: ${DEFAULT_REASONING_EFFORT}).`,
    ),
  scan: ScanSchema.optional(),
  limits: z
    .strictObject({
      max_cost_usd_per_scan: z
        .number()
        .positive()
        .optional()
        .describe(
          "Stop a scan once its estimated cost passes this amount. Needs pricing on every provider.",
        ),
    })
    .optional(),
  policy: z
    .strictObject({
      fail_on_severity: z
        .enum(FAIL_SEVERITIES)
        .optional()
        .describe("Exit with code 1 when a finding at or above this severity is reported."),
    })
    .optional(),
  output: z
    .strictObject({
      directory: nonEmpty
        .optional()
        .describe(
          "Directory for scan artifacts, outside the scanned repository (default: kongyo-scan state).",
        ),
    })
    .optional(),
  codex: z
    .record(z.string(), jsonValue)
    .optional()
    .describe("Native Codex settings passed to Codex Security, such as features or analytics."),
  python: nonEmpty
    .optional()
    .describe("Python interpreter for Codex Security (default: automatic discovery)."),
  gateway: GatewaySchema.optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

export const RESERVED_CODEX_KEYS = [
  "model",
  "model_provider",
  "model_providers",
  "model_reasoning_effort",
  "profile",
  "profiles",
  "openai_base_url",
  "chatgpt_base_url",
  "forced_login_method",
  "plugins",
  "marketplaces",
] as const;

export function emptyConfig(): Config {
  return {};
}

export function formatIssues(error: z.ZodError): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const visit = (issue: z.core.$ZodIssue, prefix: PropertyKey[]): void => {
    const path = [...prefix, ...issue.path];
    if (issue.code === "invalid_union" && issue.errors.length > 0) {
      const best = [...issue.errors].sort((a, b) => depth(b) - depth(a))[0];
      if (best && best.length > 0 && depth(best) > 0) {
        for (const nested of best) visit(nested, path);
        return;
      }
    }
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        issues.push({ path: formatPath([...path, key]), message: "is not a known setting" });
      }
      return;
    }
    issues.push({ path: formatPath(path), message: lowerFirst(issue.message) });
  };
  for (const issue of error.issues) visit(issue, []);
  return issues;
}

function depth(issues: readonly z.core.$ZodIssue[]): number {
  return Math.max(0, ...issues.map((issue) => issue.path.length));
}

export function formatPath(path: readonly PropertyKey[]): string {
  let text = "";
  for (const segment of path) {
    if (typeof segment === "number") text += `[${segment}]`;
    else text += text === "" ? String(segment) : `.${String(segment)}`;
  }
  return text === "" ? "(root)" : text;
}

function lowerFirst(text: string): string {
  return text.length > 0 ? text[0]!.toLowerCase() + text.slice(1) : text;
}
