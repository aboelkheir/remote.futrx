package opencode

import (
	"slices"
	"testing"

	"github.com/futrx-com/remote.futrx.com/internal/agent"
)

func TestArgsUseConfiguredTokenRouterModel(t *testing.T) {
	args := (&Provider{}).args(agent.RunRequest{Prompt: "inspect", Model: defaultModel})
	if !slices.Contains(args, "tokenrouter/"+defaultModel) {
		t.Fatalf("TokenRouter model missing from args: %#v", args)
	}
	if !slices.Contains(args, "--dangerously-skip-permissions") {
		t.Fatalf("headless permission policy missing from args: %#v", args)
	}
}

func TestArgsResumeAndFork(t *testing.T) {
	args := (&Provider{}).args(agent.RunRequest{Prompt: "continue", ResumeID: "session-1", Fork: true})
	if !slices.Contains(args, "--session") || !slices.Contains(args, "session-1") || !slices.Contains(args, "--fork") {
		t.Fatalf("resume/fork flags missing from args: %#v", args)
	}
}

func TestNormalizeModelRejectsUnknownModels(t *testing.T) {
	if got := normalizeModel("not-a-tokenrouter-model"); got != defaultModel {
		t.Fatalf("unknown model = %q, want %q", got, defaultModel)
	}
}
