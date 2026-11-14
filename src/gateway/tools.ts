import { createHash } from "node:crypto";

/** A plain function tool, the one shape every OpenAI-compatible endpoint accepts. */
export interface FunctionTool {
  name: string;
  description: string | undefined;
  parameters: Record<string, unknown>;
}

export interface ToolIdentity {
  name: string;
  namespace: string | undefined;
  /** "custom" tools take free-form text instead of JSON arguments. */
  kind: "function" | "custom";
}

const MAX_NAME = 64;
const CUSTOM_INPUT_KEY = "input";

/** Maps between the tool names Codex uses and the flat names sent to an endpoint. */
export class ToolNames {
  readonly #byFlat = new Map<string, ToolIdentity>();
  readonly #byIdentity = new Map<string, string>();

  register(identity: ToolIdentity): string {
    const key = identityKey(identity.name, identity.namespace);
    const existing = this.#byIdentity.get(key);
    if (existing !== undefined) return existing;
    const flat = this.#allocate(identity);
    this.#byFlat.set(flat, identity);
    this.#byIdentity.set(key, flat);
    return flat;
  }

  /** The flat name for a call recorded in history, even when its tool is no longer offered. */
  flatten(name: string, namespace?: string): string {
    return this.#byIdentity.get(identityKey(name, namespace)) ?? sanitizeName(name);
  }

  resolve(flat: string): ToolIdentity {
    return this.#byFlat.get(flat) ?? { name: flat, namespace: undefined, kind: "function" };
  }

  #allocate(identity: ToolIdentity): string {
    const bare = sanitizeName(identity.name);
    if (!this.#byFlat.has(bare)) return bare;
    if (identity.namespace !== undefined) {
      const qualified = sanitizeName(`${identity.namespace}__${identity.name}`);
      if (!this.#byFlat.has(qualified)) return qualified;
    }
    for (let counter = 2; ; counter++) {
      const suffix = `_${counter}`;
      const candidate = `${bare.slice(0, MAX_NAME - suffix.length)}${suffix}`;
      if (!this.#byFlat.has(candidate)) return candidate;
    }
  }
}

function identityKey(name: string, namespace: string | undefined): string {
  return `${namespace ?? ""}\u0000${name}`;
}

/** Function names must match ^[A-Za-z0-9_-]{1,64}$ on most endpoints. */
export function sanitizeName(name: string): string {
  const cleaned = name.replaceAll(/[^A-Za-z0-9_-]/gu, "_") || "tool";
  if (cleaned.length <= MAX_NAME) return cleaned;
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${cleaned.slice(0, MAX_NAME - digest.length - 1)}_${digest}`;
}

export interface FlattenedTools {
  functions: FunctionTool[];
  names: ToolNames;
  /** Tool types that could not be expressed as functions and were left out. */
  dropped: string[];
}

/**
 * Rewrite a Responses `tools` array as plain function tools: namespaces are
 * expanded, free-form tools take a single text argument, and hosted tools
 * (web search and the like) are dropped because only the endpoint could run them.
 */
export function flattenTools(tools: unknown): FlattenedTools {
  const names = new ToolNames();
  const functions: FunctionTool[] = [];
  const dropped: string[] = [];
  if (!Array.isArray(tools)) return { functions, names, dropped };

  const pending: {
    identity: ToolIdentity;
    tool: Record<string, unknown>;
    prefix: string | undefined;
  }[] = [];
  for (const entry of tools) {
    if (!isRecord(entry)) continue;
    const type = entry["type"];
    if (type === "function" || type === "custom") {
      if (typeof entry["name"] !== "string") continue;
      pending.push({
        identity: { name: entry["name"], namespace: undefined, kind: type },
        tool: entry,
        prefix: undefined,
      });
    } else if (type === "namespace") {
      const namespace = typeof entry["name"] === "string" ? entry["name"] : undefined;
      const members = Array.isArray(entry["tools"]) ? entry["tools"] : [];
      for (const member of members) {
        if (!isRecord(member) || typeof member["name"] !== "string") continue;
        const kind = member["type"] === "custom" ? "custom" : "function";
        pending.push({
          identity: { name: member["name"], namespace, kind },
          tool: member,
          prefix: namespace,
        });
      }
    } else if (typeof type === "string") {
      dropped.push(type);
    }
  }

  // Top-level tools claim their bare names first so namespaced ones never shadow them.
  pending.sort(
    (a, b) =>
      Number(a.identity.namespace !== undefined) - Number(b.identity.namespace !== undefined),
  );
  for (const { identity, tool } of pending) {
    const flat = names.register(identity);
    functions.push(
      identity.kind === "custom" ? customAsFunction(flat, tool) : functionTool(flat, tool),
    );
  }
  return { functions, names, dropped };
}

function functionTool(flat: string, tool: Record<string, unknown>): FunctionTool {
  const parameters = isRecord(tool["parameters"])
    ? tool["parameters"]
    : { type: "object", properties: {} };
  return {
    name: flat,
    description: typeof tool["description"] === "string" ? tool["description"] : undefined,
    parameters,
  };
}

function customAsFunction(flat: string, tool: Record<string, unknown>): FunctionTool {
  const parts: string[] = [];
  if (typeof tool["description"] === "string") parts.push(tool["description"]);
  const format = tool["format"];
  if (
    isRecord(format) &&
    format["type"] === "grammar" &&
    typeof format["definition"] === "string"
  ) {
    const syntax = typeof format["syntax"] === "string" ? format["syntax"] : "grammar";
    parts.push(
      `The ${CUSTOM_INPUT_KEY} argument must follow this ${syntax} grammar:\n${format["definition"]}`,
    );
  }
  return {
    name: flat,
    description: parts.length > 0 ? parts.join("\n\n") : undefined,
    parameters: {
      type: "object",
      properties: {
        [CUSTOM_INPUT_KEY]: {
          type: "string",
          description: "The complete free-form input for this tool.",
        },
      },
      required: [CUSTOM_INPUT_KEY],
      additionalProperties: false,
    },
  };
}

/** Encode a free-form tool input as the JSON arguments of its function stand-in. */
export function customInputToArguments(input: string): string {
  return JSON.stringify({ [CUSTOM_INPUT_KEY]: input });
}

/** Recover the free-form input from function arguments; fall back to the raw text. */
export function argumentsToCustomInput(argumentsText: string): string {
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    if (isRecord(parsed) && typeof parsed[CUSTOM_INPUT_KEY] === "string")
      return parsed[CUSTOM_INPUT_KEY];
  } catch {
    // The model produced something other than JSON; pass it through unchanged.
  }
  return argumentsText;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
