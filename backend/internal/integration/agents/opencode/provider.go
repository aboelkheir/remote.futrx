package opencode

import (
	"context"
	"errors"

	"github.com/futrx-com/remote.futrx.com/internal/agent"
	"github.com/futrx-com/remote.futrx.com/internal/agent/provisioning"
	agentruntime "github.com/futrx-com/remote.futrx.com/internal/integration/agents/runtime"
)

var (
	ErrProjectRequired      = errors.New("OpenCode is available in project chats")
	ErrTokenRouterKeyAbsent = errors.New("TokenRouter API key is not configured; add it in Settings → Agent authentication")
)

type apiKeySource interface {
	APIKey() (string, bool)
}

type Provider struct {
	projectPreparer agent.ProjectPreparer
	apiKeys         apiKeySource
	profile         provisioning.Profile
}

func newProvider(projectPreparer agent.ProjectPreparer, apiKeys apiKeySource, profile provisioning.Profile) *Provider {
	return &Provider{projectPreparer: projectPreparer, apiKeys: apiKeys, profile: profile.Clone()}
}

func (p *Provider) ID() agent.ProviderID { return agent.ProviderOpenCode }

func (p *Provider) Parser(req agent.RunRequest) agent.LineParser { return NewParser(req) }

func (p *Provider) Run(ctx context.Context, req agent.RunRequest, emit func(agent.Event)) error {
	if emit == nil {
		emit = func(agent.Event) {}
	}
	req.Provider = agent.ProviderOpenCode
	key, err := p.apiKey()
	if err != nil {
		return err
	}
	req.Model = normalizeModel(req.Model)
	cmd, err := p.buildCmd(ctx, req, p.args(req), key, emit)
	if err != nil {
		return err
	}
	return agentruntime.RunProcess(ctx, cmd, p.Parser(req), emit, agentruntime.ProcessOptions{
		Name:           "opencode",
		LogID:          req.ConversationID,
		Provider:       agent.ProviderOpenCode,
		ConversationID: req.ConversationID,
	})
}

func (p *Provider) apiKey() (string, error) {
	if p.apiKeys == nil {
		return "", ErrTokenRouterKeyAbsent
	}
	key, ok := p.apiKeys.APIKey()
	if !ok {
		return "", ErrTokenRouterKeyAbsent
	}
	return key, nil
}
