package httphandlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/futrx-com/remote.futrx.com/internal/agent"
	agentquota "github.com/futrx-com/remote.futrx.com/internal/service/agent/quota"
	serviceauth "github.com/futrx-com/remote.futrx.com/internal/service/auth"
)

type stubAgentQuota struct {
	agents []agentquota.AgentQuota
	views  int
}

func (s *stubAgentQuota) View() []agentquota.AgentQuota {
	s.views++
	return s.agents
}

func TestAgentQuotaResponseAndGuards(t *testing.T) {
	_, auth, _ := newClaimTestServer(t)
	token, err := auth.IssueSession(context.Background(), serviceauth.User{
		Email: "member@example.com", Sub: "google-member",
	}, serviceauth.SignInMethodGoogle, "", "")
	if err != nil {
		t.Fatal(err)
	}
	zero := 0.0
	for _, test := range []struct {
		name    string
		method  string
		handler *AgentQuotaHandler
		cookie  string
		status  int
		body    string
	}{
		{"nil handler", http.MethodGet, nil, "", 200, `{"agents":[]}`},
		{"nil service", http.MethodGet, NewAgentQuotaHandler(nil, nil), "", 200, `{"agents":[]}`},
		{"method before availability", http.MethodPost, nil, "", 405, `{"error":"method not allowed"}`},
		{"no auth configured", http.MethodGet, NewAgentQuotaHandler(&stubAgentQuota{}, nil), "", 200, `{"agents":[]}`},
		{"missing session", http.MethodGet, NewAgentQuotaHandler(&stubAgentQuota{}, auth), "", 401, `{"error":"authentication required"}`},
		{"invalid session", http.MethodGet, NewAgentQuotaHandler(&stubAgentQuota{}, auth), "invalid", 401, `{"error":"authentication required"}`},
		{"nil readings", http.MethodGet, NewAgentQuotaHandler(&stubAgentQuota{}, auth), token, 200, `{"agents":[]}`},
		{"reported zero", http.MethodGet, NewAgentQuotaHandler(&stubAgentQuota{agents: []agentquota.AgentQuota{{
			Provider: "codex", Session: &agent.Quota{Window: agent.QuotaWindowSession, UsedPercent: &zero, MeasuredAt: 123},
		}}}, auth), token, 200, `{"agents":[{"provider":"codex","session":{"window":"session","usedPercent":0,"measuredAt":123}}]}`},
		{"reported window without auth", http.MethodGet, NewAgentQuotaHandler(&stubAgentQuota{agents: []agentquota.AgentQuota{{
			Provider: "claude", Weekly: &agent.Quota{Window: agent.QuotaWindowWeekly, Status: "allowed", MeasuredAt: 456},
		}}}, nil), "", 200, `{"agents":[{"provider":"claude","weekly":{"window":"weekly","status":"allowed","measuredAt":456}}]}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(test.method, "/api/agent-quota", nil)
			if test.cookie != "" {
				request.AddCookie(&http.Cookie{Name: serviceauth.SessionCookieName, Value: test.cookie})
			}
			response := httptest.NewRecorder()
			test.handler.handle(response, request)
			if response.Code != test.status || response.Body.String() != test.body+"\n" {
				t.Fatalf("response = %d %s; want %d %s", response.Code, response.Body, test.status, test.body)
			}
			if response.Header().Get("Content-Type") != "application/json" {
				t.Fatalf("content type = %q", response.Header().Get("Content-Type"))
			}
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("cache control = %q", response.Header().Get("Cache-Control"))
			}
			if test.handler != nil && test.handler.quota != nil {
				wantViews := 0
				if test.status == http.StatusOK {
					wantViews = 1
				}
				if views := test.handler.quota.(*stubAgentQuota).views; views != wantViews {
					t.Fatalf("View calls = %d; want %d", views, wantViews)
				}
			}
		})
	}
}
