import { useEffect, useState } from "preact/hooks";
import { agentQuotaApi } from "../../../api/agents/agentQuotaApi";
import type { AgentQuota } from "../../../models/agentQuota";
import type { PlanQuotaRow } from "../../../models/planQuota";
import { projectPlanQuotaRows } from "./planQuotaState";
import { startPlanQuotaUpdates } from "./planQuotaUpdates";

export interface PlanQuotaState {
  rows: PlanQuotaRow[];
  loading: boolean;
}

/** Reads current snapshots while the Usage tab is mounted and ages each reading. */
export function usePlanQuota(): PlanQuotaState {
  const [quotas, setQuotas] = useState<AgentQuota[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [nowMs, setNowMs] = useState(Date.now);

  useEffect(() => startPlanQuotaUpdates({
    load: (signal) => agentQuotaApi.list(signal),
    onSnapshot: setQuotas,
    onSettled: () => setLoading(false),
    onClock: setNowMs,
  }), []);

  return {
    rows: projectPlanQuotaRows(quotas ?? [], nowMs),
    loading,
  };
}
