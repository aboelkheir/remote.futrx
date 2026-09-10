package opencode

import (
	"context"

	"github.com/futrx-com/remote.futrx.com/internal/agent"
	"github.com/futrx-com/remote.futrx.com/internal/agent/provisioning"
	agentauth "github.com/futrx-com/remote.futrx.com/internal/service/agent/auth"
	agentmodule "github.com/futrx-com/remote.futrx.com/internal/service/agent/module"
)

// NewFactory returns OpenCode configured for TokenRouter's OpenAI-compatible
// Chat Completions endpoint. The key is managed by Remote and is injected only
// into the short-lived process environment.
func NewFactory() (agentmodule.Factory, error) {
	profile := Profile()
	return agentmodule.NewFactory(agentmodule.Descriptor{
		ID:               agent.ProviderOpenCode,
		Label:            "OpenCode",
		ExecutionScopes:  []agentmodule.ExecutionScope{agentmodule.ScopeProject},
		Auth:             agentmodule.AuthManagedAPIKey,
		AuthInstructions: "Add a TokenRouter API key to use GLM 5.3 Free in project chats.",
		APIKeyAuth: &agentmodule.APIKeyAuth{
			CreateURL:       "https://www.tokenrouter.com/",
			CreateLabel:     "Create a TokenRouter API key",
			CredentialLabel: "TokenRouter API key",
		},
		Features: agentmodule.Features{
			Sessions: agentmodule.SessionSupport{Resume: true, Fork: true},
			Skills:   agentmodule.SkillsInstructions,
		},
	}, &profile, func(deps agentmodule.Dependencies, validated *provisioning.Profile) (agentmodule.Components, error) {
		apiKeys, err := agentauth.NewAPIKeyService(context.Background(), agent.ProviderOpenCode, deps.APIKeys, nil)
		if err != nil {
			return agentmodule.Components{}, err
		}
		binding := agentauth.NewAPIKeyBinding(agent.ProviderOpenCode, apiKeys)
		return agentmodule.Components{
			Provider: newProvider(deps.ProjectPreparer, apiKeys, *validated),
			Auth:     &binding,
		}, nil
	})
}

var (
	_ agent.Provider             = (*Provider)(nil)
	_ agentmodule.FactoryBuilder = NewFactory
)
