package credentials

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/futrx-com/remote.futrx.com/internal/agent/provisioning"
	"github.com/futrx-com/remote.futrx.com/internal/integration/containers/command"
)

// fileSynchronizer owns fixed host/container credential file sets.
type fileSynchronizer struct {
	runner command.Runner
}

func (s *fileSynchronizer) ensure(ctx context.Context, containerName string, spec provisioning.CredentialSpec) error {
	if !s.runner.Available() {
		return command.ErrUnavailable
	}
	if err := validateCredentialSpec(spec); err != nil {
		return err
	}

	for _, device := range spec.LegacyDevices {
		_, _ = command.RunWithTimeout(ctx, s.runner, queryTimeout, "config", "device", "remove", containerName, device)
	}

	// Gate: every PushRequired host file must exist before we touch the
	// container further. An unauthenticated provider should not leave
	// half-created dirs behind.
	for _, file := range spec.Files {
		if !file.PushRequired {
			continue
		}
		if _, err := os.Stat(file.HostPath); err != nil {
			return fmt.Errorf("host file missing (provider not authenticated yet?): %s", file.HostPath)
		}
	}

	pctx, cancel := context.WithTimeout(ctx, authPushTimeout)
	defer cancel()

	if spec.ContainerDir != "" {
		if out, err := s.runner.Run(pctx, "exec", containerName, "--",
			"install", "-d", "-m", "700", spec.ContainerDir); err != nil {
			return fmt.Errorf("mkdir %s in container: %w; output: %s",
				spec.ContainerDir, err, out)
		}
	}

	for _, file := range spec.Files {
		if _, err := os.Stat(file.HostPath); err != nil {
			// PushRequired files were already gated above; only optional
			// files can still be missing here, and we silently skip them.
			continue
		}
		if err := s.pushIfNewer(pctx, file, containerName); err != nil {
			return fmt.Errorf("push %s: %w", file.ContainerPath, err)
		}
	}
	return nil
}

func (s *fileSynchronizer) syncFromContainer(ctx context.Context, containerName string, spec provisioning.CredentialSpec) error {
	if !s.runner.Available() {
		return command.ErrUnavailable
	}
	if err := validateCredentialSpec(spec); err != nil {
		return err
	}

	if spec.HostDir != "" {
		if err := os.MkdirAll(spec.HostDir, 0o700); err != nil {
			return fmt.Errorf("create host dir %s: %w", spec.HostDir, err)
		}
		_ = os.Chmod(spec.HostDir, 0o700)
	}

	pctx, cancel := context.WithTimeout(ctx, authPushTimeout)
	defer cancel()

	for _, file := range spec.Files {
		if out, err := s.runner.Run(pctx, "exec", containerName, "--", "test", "-f", file.ContainerPath); err != nil {
			if file.PullRequired {
				return fmt.Errorf("container file missing %s: %w; output: %s",
					file.ContainerPath, err, out)
			}
			continue
		}
		if file.Validator != nil {
			if err := s.pullValidatedFile(pctx, file, containerName); err != nil {
				return err
			}
			continue
		}
		if out, err := s.runner.Run(pctx, "file", "pull", containerName+file.ContainerPath, file.HostPath); err != nil {
			return fmt.Errorf("pull %s: %w; output: %s",
				file.ContainerPath, err, out)
		}
		_ = os.Chmod(file.HostPath, 0o600)
		now := time.Now()
		_ = os.Chtimes(file.HostPath, now, now)
	}
	return nil
}

func validateCredentialSpec(spec provisioning.CredentialSpec) error {
	if spec.Name == "" {
		return errors.New("auth bundle: Name is required")
	}
	if len(spec.Files) == 0 {
		return fmt.Errorf("auth bundle %q: at least one file required", spec.Name)
	}
	return nil
}

func (s *fileSynchronizer) pushIfNewer(ctx context.Context, file provisioning.CredentialFile, containerName string) error {
	hostInfo, err := os.Stat(file.HostPath)
	if err != nil {
		return err
	}
	if file.Validator != nil {
		data, err := os.ReadFile(file.HostPath)
		if err != nil {
			return err
		}
		if !file.Validator.Valid(data) {
			// A host CLI can clear its credentials too. Never overwrite a
			// project's working login with a newer but unusable host file.
			return nil
		}
	}

	shouldPush := true
	if out, err := s.runner.Run(ctx, "exec", containerName, "--", "stat", "-c", "%Y", file.ContainerPath); err == nil {
		if containerUnix, parseErr := strconv.ParseInt(strings.TrimSpace(out), 10, 64); parseErr == nil {
			shouldPush = hostInfo.ModTime().Unix() > containerUnix
		}
	}
	if !shouldPush && file.Validator != nil {
		data, err := s.runner.Run(ctx, "exec", containerName, "--", "cat", file.ContainerPath)
		if err != nil {
			// Do not include command output: it may contain credential data.
			return fmt.Errorf("read container credentials %s: %w", file.ContainerPath, err)
		}
		shouldPush = !file.Validator.Valid([]byte(data))
	}
	if !shouldPush {
		return nil
	}

	mode := file.Mode
	if mode == "" {
		mode = "600"
	}
	if out, err := s.runner.Run(ctx, "file", "push", "--mode="+mode, file.HostPath, containerName+file.ContainerPath); err != nil {
		return fmt.Errorf("lxc file push: %w; output: %s", err, out)
	}
	return nil
}

func (s *fileSynchronizer) pullValidatedFile(ctx context.Context, file provisioning.CredentialFile, containerName string) error {
	// Stage privately beside the destination so a partial pull or cleared
	// credential document cannot destroy the canonical host login.
	temporary, err := os.CreateTemp(filepath.Dir(file.HostPath), ".credential-*")
	if err != nil {
		return fmt.Errorf("stage credentials: %w", err)
	}
	defer os.Remove(temporary.Name())
	if err := temporary.Close(); err != nil {
		return err
	}
	if _, err := s.runner.Run(ctx, "file", "pull", containerName+file.ContainerPath, temporary.Name()); err != nil {
		return fmt.Errorf("pull %s: %w", file.ContainerPath, err)
	}
	if err := os.Chmod(temporary.Name(), 0o600); err != nil {
		return err
	}
	data, err := os.ReadFile(temporary.Name())
	if err != nil {
		return err
	}
	if !file.Validator.Valid(data) {
		return fmt.Errorf("container credentials %s are unusable; sign in to the provider again", file.ContainerPath)
	}
	if err := os.Rename(temporary.Name(), file.HostPath); err != nil {
		return fmt.Errorf("replace host credentials: %w", err)
	}
	now := time.Now()
	return os.Chtimes(file.HostPath, now, now)
}
