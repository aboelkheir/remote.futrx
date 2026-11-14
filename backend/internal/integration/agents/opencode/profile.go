package opencode

import (
	"time"

	"github.com/futrx-com/remote.futrx.com/internal/agent"
	"github.com/futrx-com/remote.futrx.com/internal/agent/provisioning"
)

const (
	containerOpenCodeHome   = "/root/.opencode"
	containerOpenCodeConfig = containerOpenCodeHome + "/opencode.json"
	containerOpenCodeHash   = containerOpenCodeHome + "/.opencode.json.sha256"
	defaultModel            = "z-ai/glm-5.3-free"
	tokenRouterProvider     = "tokenrouter"
)

var openCodeProfile = provisioning.Profile{
	ID: string(agent.ProviderOpenCode),
	CLI: provisioning.CLISpec{
		Name:               "OpenCode",
		ImageLabel:         "opencode",
		Binary:             "opencode",
		VersionArgs:        []string{"--version"},
		PackageName:        "opencode-ai",
		Version:            provisioning.MustCLIVersion("OPENCODE_VERSION"),
		ReportVersion:      true,
		CheckVersion:       true,
		VerifyAfterInstall: true,
		InstallMode:        provisioning.InstallWithNPM,
		InstallTimeout:     8 * time.Minute,
		WaitTimeout:        5 * time.Minute,
	},
	PersistentState: []provisioning.PersistentDirectory{{
		Device:        "opencode-home",
		HostDirectory: "opencode",
		ContainerPath: containerOpenCodeHome,
	}},
	Instructions: &provisioning.InstructionTarget{
		Path:     containerOpenCodeHome + "/AGENTS.md",
		HashPath: containerOpenCodeHome + "/.agents.md.sha256",
	},
	WorkspaceSkills: &provisioning.WorkspaceSkills{
		WorkspaceHome: "/workspace/.opencode",
		HomeSkillsDir: containerOpenCodeHome + "/skills",
	},
	RuntimeAssets: []provisioning.RuntimeAsset{{
		Content: []byte(`{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "tokenrouter": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "TokenRouter",
      "options": {
        "baseURL": "https://api.tokenrouter.com/v1",
        "apiKey": "{env:TOKENROUTER_API_KEY}"
      },
      "models": {
        "z-ai/glm-5.3-free": {
          "name": "GLM 5.3 Free"
        }
      }
    }
  }
}
`),
		Path:     containerOpenCodeConfig,
		HashPath: containerOpenCodeHash,
		Mode:     "0600",
	}},
}

// Profile returns OpenCode's isolated project-container provisioning policy.
func Profile() provisioning.Profile {
	return openCodeProfile.Clone()
}
