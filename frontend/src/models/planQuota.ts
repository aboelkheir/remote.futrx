import type { QuotaWindowKind } from "./agentQuota";

export type QuotaTone = "ok" | "warn" | "spent" | "unknown";

/** Render-ready projection consumed by the plan-limits section. */
export interface PlanQuotaWindow {
  kind: QuotaWindowKind;
  label: string;
  tone: QuotaTone;
  percent: number | null;
  barPercent: number | null;
  measured: string;
  reset: string;
}

export interface PlanQuotaRow {
  provider: string;
  label: string;
  windows: PlanQuotaWindow[];
}
