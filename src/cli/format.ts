import type { TokenUsage } from "../gateway/types.js";

export function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  if (count === 0) return `No ${pluralForm}`;
  return `${formatCount(count)} ${count === 1 ? singular : pluralForm}`;
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m ${whole % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatClock(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatAge(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return iso;
  const seconds = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d`;
  return `${MONTHS[then.getMonth()]} ${then.getDate()}, ${then.getFullYear()}`;
}

export function formatTimestamp(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const zone = `UTC${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${local} ${zone} (${formatAge(iso, now)} ago)`;
}

export function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

export function formatTokens(usage: TokenUsage): string {
  const cached =
    usage.cachedInputTokens > 0 ? ` (${formatCount(usage.cachedInputTokens)} cached)` : "";
  return `${formatCount(usage.inputTokens)} in${cached}, ${formatCount(usage.outputTokens)} out${usage.estimated ? " (estimated)" : ""}`;
}

export function formatTokensShort(total: number): string {
  if (total < 10_000) return formatCount(total);
  if (total < 1_000_000) return `${(total / 1000).toFixed(total < 100_000 ? 1 : 0)}K`;
  return `${(total / 1_000_000).toFixed(1)}M`;
}
