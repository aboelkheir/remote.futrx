package credentials

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/futrx-com/remote.futrx.com/internal/agent/provisioning"
)

type runnerResponse struct {
	out string
	err error
}

type recordingRunner struct {
	responses map[string]runnerResponse
	calls     []string
}

type credentialPullRunner struct {
	data  []byte
	calls []string
}

type markerCredentialValidator struct{}

func (markerCredentialValidator) Valid(data []byte) bool {
	return strings.Contains(string(data), `"refreshToken":"valid"`)
}

func (r *recordingRunner) Available() bool { return true }

func (r *recordingRunner) Run(_ context.Context, args ...string) (string, error) {
	call := strings.Join(args, " ")
	r.calls = append(r.calls, call)
	response := r.responses[call]
	return response.out, response.err
}

func (r *recordingRunner) RunStdin(ctx context.Context, _ io.Reader, args ...string) (string, error) {
	return r.Run(ctx, args...)
}

func (r *credentialPullRunner) Available() bool { return true }

func (r *credentialPullRunner) Run(_ context.Context, args ...string) (string, error) {
	r.calls = append(r.calls, strings.Join(args, " "))
	if len(args) == 4 && args[0] == "file" && args[1] == "pull" {
		return "", os.WriteFile(args[3], r.data, 0o600)
	}
	return "", nil
}

func (r *credentialPullRunner) RunStdin(ctx context.Context, _ io.Reader, args ...string) (string, error) {
	return r.Run(ctx, args...)
}

func TestEnsureRejectsMissingRequiredHostFileBeforeContainerMutation(t *testing.T) {
	runner := &recordingRunner{}
	missing := filepath.Join(t.TempDir(), "missing.json")
	spec := provisioning.CredentialSpec{
		Name:         "agent",
		ContainerDir: "/root/.agent",
		Files: []provisioning.CredentialFile{{
			HostPath:      missing,
			ContainerPath: "/root/.agent/auth.json",
			PushRequired:  true,
		}},
	}

	err := NewAdapter(runner).EnsureFiles(context.Background(), "c1", spec)
	want := "host file missing (provider not authenticated yet?): " + missing
	if err == nil || err.Error() != want {
		t.Fatalf("Ensure error = %v, want %q", err, want)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("required host-file gate must precede container mutation; calls = %v", runner.calls)
	}
}

func TestEnsurePushesOnlyStrictlyNewerFilesWithDefaultMode(t *testing.T) {
	hostDir := t.TempDir()
	equalPath := filepath.Join(hostDir, "equal.json")
	newerPath := filepath.Join(hostDir, "newer.json")
	missingOptionalPath := filepath.Join(hostDir, "optional.json")
	for _, path := range []string{equalPath, newerPath} {
		if err := os.WriteFile(path, []byte("credentials"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	equalTime := time.Unix(1_700_000_000, 0)
	newerTime := equalTime.Add(time.Minute)
	if err := os.Chtimes(equalPath, equalTime, equalTime); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(newerPath, newerTime, newerTime); err != nil {
		t.Fatal(err)
	}

	runner := &recordingRunner{responses: map[string]runnerResponse{
		"exec c1 -- stat -c %Y /root/.agent/equal.json": {out: "1700000000\n"},
		"exec c1 -- stat -c %Y /root/.agent/newer.json": {out: "1700000059\n"},
	}}
	spec := provisioning.CredentialSpec{
		Name:         "agent",
		ContainerDir: "/root/.agent",
		Files: []provisioning.CredentialFile{
			{HostPath: equalPath, ContainerPath: "/root/.agent/equal.json"},
			{HostPath: newerPath, ContainerPath: "/root/.agent/newer.json"},
			{HostPath: missingOptionalPath, ContainerPath: "/root/.agent/optional.json"},
		},
	}

	if err := NewAdapter(runner).EnsureFiles(context.Background(), "c1", spec); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	wantCalls := []string{
		"exec c1 -- install -d -m 700 /root/.agent",
		"exec c1 -- stat -c %Y /root/.agent/equal.json",
		"exec c1 -- stat -c %Y /root/.agent/newer.json",
		"file push --mode=600 " + newerPath + " c1/root/.agent/newer.json",
	}
	if !reflect.DeepEqual(runner.calls, wantCalls) {
		t.Fatalf("calls = %#v, want %#v", runner.calls, wantCalls)
	}
}

func TestEnsureRepairsNewerUnusableContainerCredentials(t *testing.T) {
	hostPath := filepath.Join(t.TempDir(), "credentials.json")
	if err := os.WriteFile(hostPath, []byte(`{"refreshToken":"valid"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	hostTime := time.Unix(1_700_000_000, 0)
	if err := os.Chtimes(hostPath, hostTime, hostTime); err != nil {
		t.Fatal(err)
	}

	runner := &recordingRunner{responses: map[string]runnerResponse{
		"exec c1 -- stat -c %Y /root/.agent/credentials.json": {out: "1700000060\n"},
		"exec c1 -- cat /root/.agent/credentials.json":        {out: `{"scopes":["user:inference"]}`},
	}}
	spec := provisioning.CredentialSpec{
		Name:         "agent",
		ContainerDir: "/root/.agent",
		Files: []provisioning.CredentialFile{{
			HostPath: hostPath, ContainerPath: "/root/.agent/credentials.json",
			Validator: markerCredentialValidator{},
		}},
	}

	if err := NewAdapter(runner).EnsureFiles(context.Background(), "c1", spec); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	wantCalls := []string{
		"exec c1 -- install -d -m 700 /root/.agent",
		"exec c1 -- stat -c %Y /root/.agent/credentials.json",
		"exec c1 -- cat /root/.agent/credentials.json",
		"file push --mode=600 " + hostPath + " c1/root/.agent/credentials.json",
	}
	if !reflect.DeepEqual(runner.calls, wantCalls) {
		t.Fatalf("calls = %#v, want %#v", runner.calls, wantCalls)
	}
}

func TestEnsureNeverPushesUnusableHostCredentials(t *testing.T) {
	hostPath := filepath.Join(t.TempDir(), "credentials.json")
	if err := os.WriteFile(hostPath, []byte(`{"refreshToken":"cleared"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	runner := &recordingRunner{}
	spec := provisioning.CredentialSpec{
		Name: "agent",
		Files: []provisioning.CredentialFile{{
			HostPath: hostPath, ContainerPath: "/root/.agent/credentials.json",
			Validator: markerCredentialValidator{},
		}},
	}

	if err := NewAdapter(runner).EnsureFiles(context.Background(), "c1", spec); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("unusable host credential reached container: %v", runner.calls)
	}
}

func TestSyncFromContainerSkipsMissingOptionalFileButRejectsMissingRequiredFile(t *testing.T) {
	runner := &recordingRunner{responses: map[string]runnerResponse{
		"exec c1 -- test -f /root/.agent/optional.json": {out: "optional absent", err: errors.New("missing")},
		"exec c1 -- test -f /root/.agent/required.json": {out: "required absent", err: errors.New("missing")},
	}}
	hostDir := filepath.Join(t.TempDir(), "credentials")
	spec := provisioning.CredentialSpec{
		Name:    "agent",
		HostDir: hostDir,
		Files: []provisioning.CredentialFile{
			{HostPath: filepath.Join(hostDir, "optional.json"), ContainerPath: "/root/.agent/optional.json"},
			{HostPath: filepath.Join(hostDir, "required.json"), ContainerPath: "/root/.agent/required.json", PullRequired: true},
		},
	}

	err := NewAdapter(runner).SyncFilesFromContainer(context.Background(), "c1", spec)
	want := "container file missing /root/.agent/required.json: missing; output: required absent"
	if err == nil || err.Error() != want {
		t.Fatalf("SyncFromContainer error = %v, want %q", err, want)
	}
	wantCalls := []string{
		"exec c1 -- test -f /root/.agent/optional.json",
		"exec c1 -- test -f /root/.agent/required.json",
	}
	if !reflect.DeepEqual(runner.calls, wantCalls) {
		t.Fatalf("calls = %#v, want %#v", runner.calls, wantCalls)
	}
}

func TestSyncFromContainerDoesNotReplaceHostWithUnusableCredentials(t *testing.T) {
	hostDir := t.TempDir()
	hostPath := filepath.Join(hostDir, "credentials.json")
	want := []byte(`{"refreshToken":"valid"}`)
	if err := os.WriteFile(hostPath, want, 0o600); err != nil {
		t.Fatal(err)
	}

	runner := &credentialPullRunner{data: []byte(`{"refreshToken":"cleared"}`)}
	spec := provisioning.CredentialSpec{
		Name:    "agent",
		HostDir: hostDir,
		Files: []provisioning.CredentialFile{{
			HostPath: hostPath, ContainerPath: "/root/.agent/credentials.json",
			PullRequired: true, Validator: markerCredentialValidator{},
		}},
	}

	err := NewAdapter(runner).SyncFilesFromContainer(context.Background(), "c1", spec)
	if err == nil || !strings.Contains(err.Error(), "credentials /root/.agent/credentials.json are unusable") {
		t.Fatalf("SyncFromContainer error = %v, want unusable credentials error", err)
	}
	got, readErr := os.ReadFile(hostPath)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("host credentials = %q, want unchanged %q", got, want)
	}
}
