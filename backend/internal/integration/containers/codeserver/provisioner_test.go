package codeserver

import (
	"context"
	"io"
	"slices"
	"testing"
)

type recordingRunner struct {
	calls [][]string
}

func (*recordingRunner) Available() bool { return true }

func (r *recordingRunner) Run(_ context.Context, args ...string) (string, error) {
	r.calls = append(r.calls, slices.Clone(args))
	return "", nil
}

func (r *recordingRunner) RunStdin(ctx context.Context, _ io.Reader, args ...string) (string, error) {
	return r.Run(ctx, args...)
}

func TestEnsureConfiguresProjectPreviewTemplate(t *testing.T) {
	runner := &recordingRunner{}
	provisioner := NewProvisioner(runner, "remote.example.test")

	if err := provisioner.Ensure(context.Background(), "project-1", "My Project", "my-project"); err != nil {
		t.Fatalf("Ensure: %v", err)
	}

	wantEnv := "CODE_SERVER_PROXY_URI=https://my-project--{{port}}.dev.remote.example.test"
	wantViteEnv := "VITE_ALLOWED_HOST=.dev.remote.example.test"
	foundProxy, foundVite := false, false
	for _, call := range runner.calls {
		for _, arg := range call {
			if arg == wantEnv {
				foundProxy = true
			}
			if arg == wantViteEnv {
				foundVite = true
			}
		}
	}
	if !foundProxy {
		t.Fatalf("preview template %q missing from calls: %#v", wantEnv, runner.calls)
	}
	if !foundVite {
		t.Fatalf("Vite allowed host %q missing from calls: %#v", wantViteEnv, runner.calls)
	}
}
