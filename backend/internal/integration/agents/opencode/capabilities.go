package opencode

import (
	"context"

	"github.com/futrx-com/remote.futrx.com/internal/agent"
)

func (p *Provider) Capabilities(_ context.Context, _ agent.CapabilityRequest) (agent.Capabilities, error) {
	caps := fallbackCapabilities()
	if p.apiKeys == nil {
		caps.Warning = "Add a TokenRouter API key to use OpenCode"
		return caps, ErrTokenRouterKeyAbsent
	}
	if _, ok := p.apiKeys.APIKey(); !ok {
		caps.Warning = "Add a TokenRouter API key to use OpenCode"
		return caps, ErrTokenRouterKeyAbsent
	}
	return caps, nil
}

func fallbackCapabilities() agent.Capabilities {
	return agent.Capabilities{
		Provider: agent.ProviderOpenCode,
		Label:    "OpenCode",
		Source:   agent.CapabilitySourceFallback,
		Models: []agent.ModelCapability{{
			ID:              defaultModel,
			Label:           "GLM 5.3 Free",
			Description:     "TokenRouter",
			ProviderDefault: true,
		}},
		Modes:       agent.ProviderModes(false),
		DefaultMode: agent.RunModeDefault,
	}
}
