import type { QuotaWindowKind } from "../models/agentQuota";
import type { QuotaTone } from "../models/planQuota";

/** Visual urgency thresholds for reported subscription-plan usage. */
export const PLAN_QUOTA_WARNING_PERCENT = 70;
export const PLAN_QUOTA_SPENT_PERCENT = 90;
export const PLAN_QUOTA_MIN_VISIBLE_BAR_PERCENT = 2;

export const PLAN_QUOTA_WINDOW_LABELS: Record<QuotaWindowKind, string> = {
  session: "5-hour window",
  weekly: "This week",
};

/** The text and color for each projected quota state. */
export const PLAN_QUOTA_TONES: Record<QuotaTone, { textClass: string; label: string }> = {
  ok: { textClass: "text-accent-blue", label: "fine" },
  warn: { textClass: "text-accent-orange", label: "getting low" },
  spent: { textClass: "text-accent-red", label: "out" },
  unknown: { textClass: "text-ink-400", label: "not reported" },
};
