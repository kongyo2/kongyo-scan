import { CliError, type NextStep, usageError } from "../core/errors.js";
import { closest } from "../core/suggest.js";
import { type Config, ConfigSchema, type JsonValue, RESERVED_CODEX_KEYS } from "./schema.js";
import { validateConfig } from "./store.js";

type Container = Record<string, unknown>;

export function splitKey(key: string, config: Config): string[] {
  const trimmed = key.trim();
  if (
    trimmed === "" ||
    trimmed.startsWith(".") ||
    trimmed.endsWith(".") ||
    trimmed.includes("..")
  ) {
    throw usageError(`Can't use "${key}" as a setting name. Use dotted names such as scan.mode.`);
  }
  if (trimmed === "providers" || !trimmed.startsWith("providers.")) return trimmed.split(".");
  const rest = trimmed.slice("providers.".length);
  const names = (config.providers ?? [])
    .map((provider) => provider.name)
    .sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (rest === name) return ["providers", name];
    if (rest.startsWith(`${name}.`))
      return ["providers", name, ...rest.slice(name.length + 1).split(".")];
  }
  const [name = "", ...fields] = rest.split(".");
  return ["providers", name, ...fields];
}

const CREDENTIAL_NAME =
  /(?:(?:^|[-_.])key|api[-_]?key|token|secret|password|passphrase|credentials?|authorization|cookie|signature)$/iu;
const PLACEHOLDER_ONLY = /^(?:[A-Za-z][A-Za-z0-9-]* +)?\{(?:api_key|session_id)\}$/u;

function isSecretKey(segments: readonly string[]): boolean {
  if (segments[0] === "providers" && segments.length < 3) return false;
  return CREDENTIAL_NAME.test(segments.at(-1) ?? "");
}

export function isSecretValue(segments: readonly string[], value: unknown): value is string {
  return typeof value === "string" && isSecretKey(segments) && !PLACEHOLDER_ONLY.test(value);
}

export function redact(value: unknown, segments: readonly string[] = []): unknown {
  if (Array.isArray(value))
    return value.map((item, index) => redact(item, [...segments, String(index)]));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Container).map(([key, child]) => [
        key,
        redact(child, [...segments, key]),
      ]),
    );
  }
  return isSecretValue(segments, value) ? maskSecret(value) : value;
}

function providerIndex(config: Config, name: string): number {
  const index = (config.providers ?? []).findIndex(
    (provider) => provider.name.toLowerCase() === name.toLowerCase(),
  );
  if (index < 0) {
    throw new CliError("not_found", `Couldn't find provider ${JSON.stringify(name)}.`, {
      reason: "provider_not_found",
      next: [{ label: "List configured providers", argv: ["kongyo-scan", "providers", "list"] }],
    });
  }
  return index;
}

export function getValue(config: Config, key: string): unknown {
  const segments = splitKey(key, config);
  let current: unknown = config;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    if (index === 1 && segments[0] === "providers") {
      current = (config.providers ?? [])[providerIndex(config, segment)];
      continue;
    }
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Container)[segment];
  }
  return current;
}

export function valueCandidates(raw: string): JsonValue[] {
  const candidates: JsonValue[] = [];
  const text = raw.trim();
  if (text !== "") {
    try {
      const parsed = JSON.parse(text) as JsonValue;
      if (typeof parsed !== "string" || text.startsWith('"')) candidates.push(parsed);
    } catch {
      // Not JSON; fall through to the literal string.
    }
  }
  candidates.push(raw);
  return candidates;
}

function assign(config: Config, segments: readonly string[], value: unknown): Config {
  const draft = structuredClone(config) as Container;
  if (segments[0] === "providers" && segments.length >= 2) {
    const providers = [...((draft["providers"] as unknown[] | undefined) ?? [])];
    const index = providerIndex(config, segments[1]!);
    if (segments.length === 2) providers[index] = value;
    else providers[index] = assignPath(providers[index] as Container, segments.slice(2), value);
    draft["providers"] = providers;
    return draft as Config;
  }
  return assignPath(draft, segments, value) as Config;
}

function assignPath(target: Container, segments: readonly string[], value: unknown): Container {
  const [head, ...rest] = segments;
  if (head === undefined) return target;
  if (["__proto__", "constructor", "prototype"].includes(head)) {
    throw usageError(`Can't use "${head}" as a setting name.`);
  }
  const copy: Container = { ...target };
  if (rest.length === 0) {
    if (value === undefined) delete copy[head];
    else copy[head] = value;
    return copy;
  }
  const child = copy[head];
  const base =
    child !== null && typeof child === "object" && !Array.isArray(child)
      ? (child as Container)
      : {};
  const next = assignPath(base, rest, value);
  if (value === undefined && Object.keys(next).length === 0) delete copy[head];
  else copy[head] = next;
  return copy;
}

function rejectReservedCodexKey(segments: readonly string[]): void {
  if (segments[0] !== "codex" || segments.length < 2) return;
  const key = segments[1]!;
  if ((RESERVED_CODEX_KEYS as readonly string[]).includes(key)) {
    throw usageError(`Can't set codex.${key}. kongyo-scan manages it from the provider chain.`, {
      hint:
        key === "model_reasoning_effort"
          ? "Set reasoning_effort instead."
          : "Configure providers with kongyo-scan providers.",
    });
  }
}

export function setValue(config: Config, key: string, raw: string, path: string): Config {
  const segments = splitKey(key, config);
  rejectReservedCodexKey(segments);
  let firstError: unknown;
  for (const candidate of valueCandidates(raw)) {
    try {
      return validateConfig(assign(config, segments, candidate), path);
    } catch (error) {
      if (!(error instanceof CliError) || error.errorClass !== "config") throw error;
      firstError ??= error;
    }
  }
  if (firstError instanceof CliError) {
    const detail = firstError.issues[0]?.message ?? firstError.details[0];
    const suggestion = detail?.endsWith(UNKNOWN_SETTING) ? suggestKey(segments) : undefined;
    const next: NextStep[] = [
      { label: "List the settings and their meaning", argv: ["kongyo-scan", "config", "keys"] },
    ];
    if (suggestion !== undefined)
      next.unshift({
        label: `Set ${suggestion}`,
        argv: ["kongyo-scan", "config", "set", suggestion, raw],
      });
    throw usageError(
      `Can't set ${key}. ${detail ?? "The value isn't valid for this setting."}${suggestion === undefined ? "" : ` Did you mean ${suggestion}?`}`,
      {
        issues: firstError.issues,
        next,
        ...(suggestion === undefined ? {} : { data: { suggestion } }),
      },
    );
  }
  throw firstError;
}

const UNKNOWN_SETTING = "is not a known setting.";

function suggestKey(segments: readonly string[]): string | undefined {
  const provider = segments[0] === "providers" && segments.length >= 3 ? segments[1] : undefined;
  const typed =
    provider === undefined
      ? segments.join(".")
      : ["providers", "<name>", ...segments.slice(2)].join(".");
  const match = closest(
    typed,
    settingDocs().map((doc) => doc.key),
  );
  if (match === undefined || match === typed) return undefined;
  return provider === undefined ? match : match.replace("<name>", provider);
}

export function unsetValue(
  config: Config,
  key: string,
  path: string,
): { config: Config; changed: boolean } {
  const segments = splitKey(key, config);
  if (segments[0] === "providers" && segments.length === 2) {
    const index = providerIndex(config, segments[1]!);
    const providers = [...(config.providers ?? [])];
    providers.splice(index, 1);
    return { config: validateConfig({ ...config, providers }, path), changed: true };
  }
  if (getValue(config, key) === undefined) return { config, changed: false };
  return { config: validateConfig(assign(config, segments, undefined), path), changed: true };
}

export interface SettingDoc {
  key: string;
  type: string;
  description: string;
}

export function settingDocs(): SettingDoc[] {
  const docs: SettingDoc[] = [];
  const schema = ConfigSchema.toJSONSchema({ io: "input", unrepresentable: "any" }) as SchemaNode;
  const visit = (node: SchemaNode, prefix: string): void => {
    for (const [name, child] of Object.entries(node.properties ?? {})) {
      if (name === "$schema") continue;
      const key = prefix === "" ? name : `${prefix}.${name}`;
      if (key === "providers") {
        visit(child.items ?? {}, "providers.<name>");
        continue;
      }
      const variants = child.anyOf ?? child.oneOf;
      if (child.type === "object" && child.properties) {
        visit(child, key);
      } else if (
        variants &&
        variants.every((variant) => variant.type === "object" && variant.properties)
      ) {
        for (const variant of variants) visit(variant, key);
      } else {
        docs.push({ key, type: describeType(child), description: child.description ?? "" });
      }
    }
  };
  visit(schema, "");
  return docs.filter((doc) => doc.key !== "providers.<name>.name");
}

interface SchemaNode {
  type?: string;
  description?: string;
  enum?: unknown[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  additionalProperties?: SchemaNode | boolean;
}

function describeType(node: SchemaNode): string {
  if (node.enum) return node.enum.map(String).join("|");
  if (node.type === "array") return `${describeType(node.items ?? {})}[]`;
  if (node.type === "object") return "object";
  if (node.type === "integer") return "number";
  return node.type ?? "value";
}

export interface SettingRow {
  key: string;
  segments: string[];
  value: unknown;
  secret: boolean;
}

export function flattenConfig(config: Config): SettingRow[] {
  const rows: SettingRow[] = [];
  const visit = (value: unknown, segments: string[]): void => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const entries = Object.entries(value as Container);
      if (entries.length === 0 && segments.length > 0) {
        rows.push({ key: segments.join("."), segments, value, secret: false });
      }
      for (const [name, child] of entries) visit(child, [...segments, name]);
      return;
    }
    rows.push({
      key: segments.join("."),
      segments,
      value,
      secret: isSecretValue(segments, value),
    });
  };
  for (const [name, value] of Object.entries(config)) {
    if (name === "$schema") continue;
    if (name === "providers") {
      for (const provider of config.providers ?? []) {
        const { name: providerName, ...fields } = provider;
        visit(fields, ["providers", providerName]);
      }
      continue;
    }
    visit(value, [name]);
  }
  return rows;
}

export function maskSecret(value: string): string {
  if (value.length < 12) return "****";
  return `****${value.slice(-4)}`;
}
