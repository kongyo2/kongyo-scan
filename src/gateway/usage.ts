import { emptyUsage, type Pricing, type TokenUsage } from "./types.js";

export interface ProviderUsage {
  provider: string;
  model: string;
  requests: number;
  failures: number;
  usage: TokenUsage;
  costUsd: number | null;
}

export interface UsageSummary {
  providers: ProviderUsage[];
  total: TokenUsage;
  requests: number;
  costUsd: number | null;
}

export function costOf(usage: TokenUsage, pricing: Pricing): number {
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (
    (uncached * pricing.inputPerMtok +
      usage.cachedInputTokens * pricing.cachedInputPerMtok +
      usage.outputTokens * pricing.outputPerMtok) /
    1_000_000
  );
}

export function addUsage(target: TokenUsage, usage: TokenUsage): void {
  target.inputTokens += usage.inputTokens;
  target.cachedInputTokens += usage.cachedInputTokens;
  target.outputTokens += usage.outputTokens;
  target.reasoningTokens += usage.reasoningTokens;
  target.totalTokens += usage.totalTokens;
  target.estimated ||= usage.estimated;
}

export class UsageLedger {
  readonly #entries = new Map<string, ProviderUsage & { pricing: Pricing | undefined }>();

  #entry(
    provider: string,
    model: string,
    pricing: Pricing | undefined,
  ): ProviderUsage & { pricing: Pricing | undefined } {
    let entry = this.#entries.get(provider);
    if (!entry) {
      entry = {
        provider,
        model,
        requests: 0,
        failures: 0,
        usage: emptyUsage(),
        costUsd: pricing ? 0 : null,
        pricing,
      };
      this.#entries.set(provider, entry);
    }
    return entry;
  }

  recordSuccess(
    provider: string,
    model: string,
    pricing: Pricing | undefined,
    usage: TokenUsage,
  ): void {
    const entry = this.#entry(provider, model, pricing);
    entry.requests += 1;
    addUsage(entry.usage, usage);
    if (entry.pricing && entry.costUsd !== null) entry.costUsd += costOf(usage, entry.pricing);
  }

  recordFailure(provider: string, model: string, pricing: Pricing | undefined): void {
    this.#entry(provider, model, pricing).failures += 1;
  }

  summary(): UsageSummary {
    const providers: ProviderUsage[] = [];
    const total = emptyUsage();
    let requests = 0;
    let cost: number | null = 0;
    for (const entry of this.#entries.values()) {
      const { pricing: _pricing, ...row } = entry;
      providers.push({ ...row, usage: { ...row.usage } });
      addUsage(total, entry.usage);
      requests += entry.requests;
      if (entry.requests > 0)
        cost = cost === null || entry.costUsd === null ? null : cost + entry.costUsd;
    }
    return { providers, total, requests, costUsd: requests === 0 ? null : cost };
  }
}
