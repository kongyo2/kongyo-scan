import type { JsonObject, WireApi } from "../config/schema.js";

export interface Pricing {
  inputPerMtok: number;
  cachedInputPerMtok: number;
  outputPerMtok: number;
}

export interface ResolvedProvider {
  name: string;
  baseUrl: string;
  model: string;
  wireApi: WireApi;
  apiKey: string | undefined;
  apiKeySource: string | undefined;
  headers: Record<string, string>;
  queryParams: Record<string, string>;
  reasoningEffort: string | undefined;
  contextWindow: number | undefined;
  maxOutputTokens: number | undefined;
  firstByteTimeoutMs: number;
  pricing: Pricing | undefined;
  compat: {
    nativeResponses: boolean;
    images: boolean;
    omitParams: readonly string[];
    extraBody: JsonObject;
  };
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  estimated: boolean;
}

export function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    estimated: false,
  };
}

export type FailureKind =
  | "auth"
  | "quota"
  | "rate_limit"
  | "context_length"
  | "not_found"
  | "bad_request"
  | "server"
  | "network"
  | "timeout"
  | "protocol";

export interface UpstreamFailure {
  provider: string;
  kind: FailureKind;
  status: number | undefined;
  code: string | undefined;
  message: string;
  retryAfterMs: number | undefined;
}

export class UpstreamError extends Error {
  readonly failure: UpstreamFailure;

  constructor(failure: UpstreamFailure, cause?: unknown) {
    super(failure.message, cause === undefined ? undefined : { cause });
    this.name = "UpstreamError";
    this.failure = failure;
  }
}

export type GatewayEvent =
  | { type: "request"; id: number; sessionId: string | undefined; at: number }
  | { type: "attempt"; id: number; provider: string; model: string; wireApi: WireApi }
  | { type: "failure"; id: number; failure: UpstreamFailure; committed: boolean }
  | { type: "fallback"; id: number; from: string; to: string; failure: UpstreamFailure }
  | {
      type: "completed";
      id: number;
      provider: string;
      model: string;
      usage: TokenUsage;
      durationMs: number;
      outputTypes: string[];
      continued: boolean;
    }
  | { type: "exhausted"; id: number; failures: UpstreamFailure[] }
  | { type: "aborted"; id: number };

export type GatewayObserver = (event: GatewayEvent) => void;
