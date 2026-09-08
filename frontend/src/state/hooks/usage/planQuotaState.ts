import { PROVIDER_DISPLAY_LABELS } from "../../../config/agents.ts";
import {
  PLAN_QUOTA_SPENT_PERCENT,
  PLAN_QUOTA_WARNING_PERCENT,
  PLAN_QUOTA_WINDOW_LABELS,
} from "../../../config/planQuota.ts";
import type {
  AgentQuota,
  QuotaWindow,
  QuotaWindowKind,
} from "../../../models/agentQuota.ts";
import type {
  PlanQuotaRow,
  PlanQuotaWindow,
  QuotaTone,
} from "../../../models/planQuota.ts";

/** Projects API quota snapshots into the exact rows rendered by the Usage tab. */
export function projectPlanQuotaRows(
  quotas: AgentQuota[],
  nowMs: number
): PlanQuotaRow[] {
  return quotas.flatMap((quota) => {
    const windows = [
      projectWindow("session", quota.session, nowMs),
      projectWindow("weekly", quota.weekly, nowMs),
    ].filter((window): window is PlanQuotaWindow => window !== null);
    if (windows.length === 0) return [];

    return [
      {
        provider: quota.provider,
        label: PROVIDER_DISPLAY_LABELS[quota.provider] ?? quota.provider,
        windows,
      },
    ];
  });
}

function projectWindow(
  kind: QuotaWindowKind,
  window: QuotaWindow | undefined,
  nowMs: number
): PlanQuotaWindow | null {
  if (!window) return null;
  const usedPercent = reportedPercent(window.usedPercent);
  const percent = usedPercent === null ? null : Math.round(usedPercent);
  return {
    kind,
    label: PLAN_QUOTA_WINDOW_LABELS[kind],
    tone: quotaTone(window, usedPercent),
    percent,
    barPercent: percent === null ? null : Math.min(100, percent),
    measured: measuredAgo(window, nowMs),
    reset: resetsIn(window, nowMs),
  };
}

function reportedPercent(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function quotaTone(window: QuotaWindow, usedPercent: number | null): QuotaTone {
  const status = typeof window.status === "string" ? window.status.toLowerCase() : "";
  if (status === "rejected" || status === "exhausted") return "spent";
  if (usedPercent !== null) {
    if (usedPercent >= PLAN_QUOTA_SPENT_PERCENT) return "spent";
    if (usedPercent >= PLAN_QUOTA_WARNING_PERCENT) return "warn";
    return "ok";
  }
  if (status === "allowed_warning") return "warn";
  if (status === "allowed") return "ok";
  return "unknown";
}

function resetsIn(window: QuotaWindow, nowMs: number): string {
  if (!Number.isFinite(window.resetsAt) || !window.resetsAt || window.resetsAt < 0) return "";
  const seconds = window.resetsAt - Math.floor(nowMs / 1000);
  if (seconds <= 0) return "reset passed; awaiting a new reading";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `resets in ${days}d ${hours % 24}h`;
  }
  if (hours > 0) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}

function measuredAgo(window: QuotaWindow, nowMs: number): string {
  if (!Number.isFinite(window.measuredAt) || window.measuredAt <= 0) return "at an unknown time";
  const minutes = Math.floor((nowMs - window.measuredAt) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
