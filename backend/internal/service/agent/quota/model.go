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
