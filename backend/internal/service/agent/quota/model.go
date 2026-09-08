package quota

import "github.com/futrx-com/remote.futrx.com/internal/agent"

// AgentQuota is every window one agent has reported.
type AgentQuota struct {
	Provider string `json:"provider"`
	// Session and Weekly are pointers because "not reported" and "reported
	// as empty" are different states and only one of them should render.
	Session *agent.Quota `json:"session,omitempty"`
	Weekly  *agent.Quota `json:"weekly,omitempty"`
}

func (q AgentQuota) clone() AgentQuota {
	q.Session = cloneWindow(q.Session)
	q.Weekly = cloneWindow(q.Weekly)
	return q
}

func cloneWindow(window *agent.Quota) *agent.Quota {
	if window == nil {
		return nil
	}
	copy := *window
	if window.UsedPercent != nil {
		used := *window.UsedPercent
		copy.UsedPercent = &used
	}
	return &copy
}

func cloneReadings(readings map[string]AgentQuota) map[string]AgentQuota {
	copy := make(map[string]AgentQuota, len(readings))
	for id, reading := range readings {
		copy[id] = reading.clone()
	}
	return copy
}
