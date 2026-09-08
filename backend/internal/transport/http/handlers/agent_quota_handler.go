package httphandlers

import (
	"net/http"

	agentquota "github.com/futrx-com/remote.futrx.com/internal/service/agent/quota"
	serviceauth "github.com/futrx-com/remote.futrx.com/internal/service/auth"
	httptransport "github.com/futrx-com/remote.futrx.com/internal/transport/http"
)

// AgentQuotaService reports the last subscription window each agent mentioned.
type AgentQuotaService interface {
	View() []agentquota.AgentQuota
}

// AgentQuotaHandler serves the settings plan-quota card.
type AgentQuotaHandler struct {
	quota AgentQuotaService
	auth  *serviceauth.Service
}

type agentQuotaResponse struct {
	Agents []agentquota.AgentQuota `json:"agents"`
}

func NewAgentQuotaHandler(quota AgentQuotaService, auth *serviceauth.Service) *AgentQuotaHandler {
	return &AgentQuotaHandler{quota: quota, auth: auth}
}

func (h *AgentQuotaHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/agent-quota", h.handle)
}

// handle answers any signed-in user, or a caller on an auth-disabled install.
//
// An empty list is a real answer, not an error: readings only arrive while an
// agent runs, so a platform nobody has used yet genuinely knows nothing. The
// browser hides the section until a provider has reported a window.
func (h *AgentQuotaHandler) handle(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		httptransport.SendErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if h == nil || h.quota == nil {
		sendAgentQuota(w, nil)
		return
	}
	if h.auth != nil {
		email, _, err := httptransport.NewPrincipalResolver(h.auth).EmailAndAdmin(r.Context(), r)
		if err != nil || email == "" {
			httptransport.SendErr(w, http.StatusUnauthorized, "authentication required")
			return
		}
	}
	sendAgentQuota(w, h.quota.View())
}

func sendAgentQuota(w http.ResponseWriter, agents []agentquota.AgentQuota) {
	if agents == nil {
		agents = []agentquota.AgentQuota{}
	}
	httptransport.SendJSON(w, http.StatusOK, agentQuotaResponse{Agents: agents})
}
