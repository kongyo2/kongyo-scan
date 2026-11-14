import { type AttemptContext, type AttemptResult, runAttempt } from "./attempts.js";
import type { ResponsesRequest } from "./chat-request.js";
import {
  cooldownFor,
  protocolFailure,
  representativeFailure,
  summarizeFailures,
} from "./failure.js";
import { type Relay, streamErrorCode } from "./relay.js";
import { TurnGuard } from "./turn-guard.js";
import {
  type GatewayObserver,
  type ResolvedProvider,
  UpstreamError,
  type UpstreamFailure,
} from "./types.js";
import type { RequestMeta } from "./upstream.js";
import { UsageLedger } from "./usage.js";

export interface ChainOptions {
  providers: readonly ResolvedProvider[];
  /** How long a failing provider is skipped, in milliseconds. */
  cooldownMs: number;
  /** Maximum silence within one streamed response, in milliseconds. */
  idleTimeoutMs: number;
  observer?: GatewayObserver;
  /** Injectable for tests. */
  now?: () => number;
  attempt?: (context: AttemptContext) => Promise<AttemptResult>;
}

export interface ProviderHealth {
  provider: string;
  /** Epoch milliseconds until which the provider is skipped; 0 when healthy. */
  coolingUntil: number;
  lastFailure: UpstreamFailure | undefined;
}

/**
 * Serves each request from the first healthy provider, falling back down the
 * configured order. A provider that fails is skipped for a cooldown period.
 */
export class ProviderChain {
  readonly ledger = new UsageLedger();
  readonly #guard = new TurnGuard();
  readonly #options: ChainOptions;
  readonly #health = new Map<string, ProviderHealth>();
  readonly #now: () => number;
  readonly #attempt: (context: AttemptContext) => Promise<AttemptResult>;
  #requestCounter = 0;

  constructor(options: ChainOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#attempt = options.attempt ?? runAttempt;
    for (const provider of options.providers) {
      this.#health.set(provider.name, {
        provider: provider.name,
        coolingUntil: 0,
        lastFailure: undefined,
      });
    }
  }

  get providers(): readonly ResolvedProvider[] {
    return this.#options.providers;
  }

  health(): ProviderHealth[] {
    return this.#options.providers.map((provider) => ({ ...this.#health.get(provider.name)! }));
  }

  /** Healthy providers in configured order, then cooling ones by soonest recovery. */
  candidates(): ResolvedProvider[] {
    const now = this.#now();
    const ready: ResolvedProvider[] = [];
    const cooling: ResolvedProvider[] = [];
    for (const provider of this.#options.providers) {
      if ((this.#health.get(provider.name)?.coolingUntil ?? 0) > now) cooling.push(provider);
      else ready.push(provider);
    }
    cooling.sort(
      (a, b) =>
        (this.#health.get(a.name)?.coolingUntil ?? 0) -
        (this.#health.get(b.name)?.coolingUntil ?? 0),
    );
    return [...ready, ...cooling];
  }

  async handle(
    request: ResponsesRequest,
    requestCharacters: number,
    meta: RequestMeta,
    relay: Relay,
    signal: AbortSignal,
  ): Promise<void> {
    const id = ++this.#requestCounter;
    const observe = this.#options.observer ?? (() => undefined);
    observe({ type: "request", id, sessionId: meta.sessionId, at: this.#now() });

    const candidates = this.candidates();
    const failures: UpstreamFailure[] = [];
    for (let index = 0; index < candidates.length; index++) {
      const provider = candidates[index]!;
      if (signal.aborted) {
        observe({ type: "aborted", id });
        return;
      }
      observe({
        type: "attempt",
        id,
        provider: provider.name,
        model: provider.model,
        wireApi: provider.wireApi,
      });
      const started = this.#now();
      try {
        // oxlint-disable-next-line no-await-in-loop -- fallback is sequential by design: the next provider is tried only after this one failed.
        const result = await this.#attempt({
          provider,
          request,
          requestCharacters,
          meta,
          relay,
          signal,
          idleTimeoutMs: this.#options.idleTimeoutMs,
          guard: this.#guard,
        });
        relay.end();
        this.#markHealthy(provider.name);
        this.ledger.recordSuccess(provider.name, provider.model, provider.pricing, result.usage);
        observe({
          type: "completed",
          id,
          provider: provider.name,
          model: result.model,
          usage: result.usage,
          durationMs: this.#now() - started,
          outputTypes: result.outputTypes,
          continued: result.continued,
        });
        return;
      } catch (error) {
        if (signal.aborted) {
          observe({ type: "aborted", id });
          return;
        }
        const failure =
          error instanceof UpstreamError
            ? error.failure
            : protocolFailure(
                provider.name,
                error instanceof Error ? error.message : String(error),
              );
        failures.push(failure);
        this.#markFailed(provider.name, failure);
        this.ledger.recordFailure(provider.name, provider.model, provider.pricing);
        observe({ type: "failure", id, failure, committed: relay.committed });
        if (relay.committed) {
          // Output already reached Codex; end this stream so it retries, now on a healthier provider.
          relay.fail(
            streamErrorCode(failure) ?? "upstream_error",
            `${failure.provider}: ${failure.message}`,
          );
          return;
        }
        relay.reset();
        const next = candidates[index + 1];
        if (next) observe({ type: "fallback", id, from: provider.name, to: next.name, failure });
      }
    }

    observe({ type: "exhausted", id, failures });
    this.#reportExhausted(relay, failures);
  }

  #markHealthy(name: string): void {
    const health = this.#health.get(name);
    if (health) health.coolingUntil = 0;
  }

  #markFailed(name: string, failure: UpstreamFailure): void {
    const health = this.#health.get(name);
    if (!health) return;
    health.lastFailure = failure;
    const cooldown = cooldownFor(failure, this.#options.cooldownMs);
    if (cooldown > 0) health.coolingUntil = Math.max(health.coolingUntil, this.#now() + cooldown);
  }

  #reportExhausted(relay: Relay, failures: readonly UpstreamFailure[]): void {
    const failure = representativeFailure(failures);
    if (!failure) {
      relay.reject(400, "no_providers", "kongyo-scan: no provider is configured.");
      return;
    }
    const count = failures.length;
    const scope = count === 1 ? "The provider failed" : `All ${count} providers failed`;
    const summary = `kongyo-scan: ${scope}. ${summarizeFailures(failures)}`;
    const code = streamErrorCode(failure);
    if (code === "rate_limit_exceeded") {
      relay.fail(code, `${summary} Please try again in ${this.#retrySeconds(failures)}s.`);
    } else if (code !== null) {
      relay.fail(code, summary);
    } else if (failure.kind === "auth") {
      relay.reject(401, "invalid_api_key", summary, "authentication_error");
    } else if (failure.kind === "not_found") {
      relay.reject(404, "model_not_found", summary);
    } else {
      relay.reject(400, failure.code ?? "invalid_request_error", summary);
    }
  }

  /** Seconds until the soonest provider is worth trying again. */
  #retrySeconds(failures: readonly UpstreamFailure[]): number {
    const now = this.#now();
    const waits = failures.map((failure) => {
      const until = this.#health.get(failure.provider)?.coolingUntil ?? 0;
      return Math.max(failure.retryAfterMs ?? 0, until - now);
    });
    const soonest = Math.min(...waits.filter((wait) => wait > 0), 60_000);
    return Math.max(1, Math.ceil((Number.isFinite(soonest) ? soonest : 5_000) / 1000));
  }
}
