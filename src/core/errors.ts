export type ErrorClass =
  | "usage"
  | "missing_input"
  | "config"
  | "not_found"
  | "conflict"
  | "auth"
  | "limit"
  | "network"
  | "platform"
  | "unknown_outcome"
  | "internal";

export type ErrorReason =
  | "invalid_arguments"
  | "unknown_option"
  | "unknown_command"
  | "missing_provider"
  | "missing_input"
  | "confirmation_required"
  | "invalid_config"
  | "not_found"
  | "provider_not_found"
  | "scan_not_found"
  | "conflict"
  | "provider_exists"
  | "file_exists"
  | "invalid_credentials"
  | "missing_credentials"
  | "rate_limited"
  | "quota_exceeded"
  | "network_error"
  | "provider_error"
  | "all_providers_failed"
  | "scan_failed"
  | "unsupported_runtime"
  | "spawn_failed"
  | "timeout"
  | "internal_error"
  | "canceled";

export interface NextStep {
  label: string;
  argv: string[];
  when?: string;
}

export interface Issue {
  field: string;
  reason: string;
  message: string;
}

export interface CliErrorOptions {
  reason: ErrorReason;
  rows?: readonly (readonly [string, string])[];
  details?: readonly string[];
  next?: readonly NextStep[];
  hint?: string;
  data?: Record<string, unknown>;
  issues?: readonly Issue[];
  retryable?: boolean;
  cause?: unknown;
}

const EXIT_CODE: Record<ErrorClass, number> = {
  usage: 2,
  missing_input: 2,
  config: 1,
  not_found: 1,
  conflict: 1,
  auth: 1,
  limit: 1,
  network: 1,
  platform: 1,
  unknown_outcome: 1,
  internal: 1,
};

export class CliError extends Error {
  readonly errorClass: ErrorClass;
  readonly reason: ErrorReason;
  readonly rows: readonly (readonly [string, string])[];
  readonly details: readonly string[];
  readonly next: readonly NextStep[];
  readonly hint: string | undefined;
  readonly data: Record<string, unknown> | undefined;
  readonly issues: readonly Issue[];
  readonly retryable: boolean | undefined;

  constructor(errorClass: ErrorClass, message: string, options: CliErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CliError";
    this.errorClass = errorClass;
    this.reason = options.reason;
    this.rows = options.rows ?? [];
    this.details = options.details ?? [];
    this.next = options.next ?? [];
    this.hint = options.hint;
    this.data = options.data;
    this.issues = options.issues ?? [];
    this.retryable = options.retryable;
  }

  get exitCode(): number {
    return EXIT_CODE[this.errorClass];
  }

  get status(): "action_required" | "error" {
    return this.errorClass === "usage" || this.errorClass === "missing_input"
      ? "action_required"
      : "error";
  }
}

export class CanceledError extends Error {
  readonly summary: string;
  readonly signal: NodeJS.Signals | undefined;

  constructor(summary = "Nothing was changed.", signal?: NodeJS.Signals) {
    super("Canceled.");
    this.name = "CanceledError";
    this.summary = summary;
    this.signal = signal;
  }

  get exitCode(): number {
    if (this.signal === "SIGTERM") return 143;
    if (this.signal === "SIGHUP") return 129;
    return 130;
  }
}

export function usageError(
  message: string,
  options: Omit<CliErrorOptions, "reason"> & { reason?: ErrorReason } = {},
): CliError {
  return new CliError("usage", message, {
    ...options,
    reason: options.reason ?? "invalid_arguments",
  });
}

export function configError(
  message: string,
  options: Omit<CliErrorOptions, "reason"> = {},
): CliError {
  return new CliError("config", message, { ...options, reason: "invalid_config" });
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? error.cause.message : undefined;
    const text =
      cause && !error.message.includes(cause) ? `${error.message}: ${cause}` : error.message;
    return sanitizeLine(text);
  }
  return sanitizeLine(String(error));
}

export function sanitizeLine(text: string): string {
  return text
    .replaceAll(/\r?\n/gu, " ")
    .replaceAll(/(?!\t)\p{Cc}|[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/gu, "")
    .replaceAll(/\s{2,}/gu, " ")
    .trim();
}
