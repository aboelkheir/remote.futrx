package opencode

import (
	"context"
	"os/exec"
	"strings"

	"github.com/futrx-com/remote.futrx.com/internal/agent"
	agentruntime "github.com/futrx-com/remote.futrx.com/internal/integration/agents/runtime"
)

func normalizeModel(model string) string {
	if strings.TrimSpace(model) == defaultModel {
		return defaultModel
	}
	return defaultModel
}

func (p *Provider) args(req agent.RunRequest) []string {
	args := []string{"run", "--format", "json", "--model", tokenRouterProvider + "/" + normalizeModel(req.Model), "--dangerously-skip-permissions"}
	if req.ResumeID != "" {
		args = append(args, "--session", req.ResumeID)
	}
	if req.Fork && req.ResumeID != "" {
		args = append(args, "--fork")
	}
	return append(args, req.Prompt)
}

func (p *Provider) buildCmd(ctx context.Context, req agent.RunRequest, args []string, apiKey string, emit func(agent.Event)) (*exec.Cmd, error) {
	if req.ProjectID == "" || p.projectPreparer == nil {
		return nil, ErrProjectRequired
	}
	project, err := p.projectPreparer.Prepare(ctx, agent.ProjectPreparationRequest{
		ProjectID:      agent.ProjectID(req.ProjectID),
		ConversationID: req.ConversationID,
	}, emit)
	if err != nil {
		return nil, err
	}
	runtimeEnvironment := make(map[string]string, len(req.RuntimeEnv)+1)
	for key, value := range req.RuntimeEnv {
		runtimeEnvironment[key] = value
	}
	runtimeEnvironment["TOKENROUTER_API_KEY"] = apiKey
	return agentruntime.BuildContainerCommand(ctx, agentruntime.ContainerCommandSpec{
		ContainerName: project.ContainerName,
		PrefixEnvironment: []string{
			"HOME=/root",
			"OPENCODE_CONFIG=" + containerOpenCodeConfig,
		},
		Secrets: project.Secrets,
		ExcludedSecrets: []string{
			"HOME", "OPENCODE_CONFIG", "TOKENROUTER_API_KEY",
		},
		RuntimeEnvironment: runtimeEnvironment,
		Binary:             p.profile.CLI.Binary,
		Arguments:          args,
	}), nil
}
