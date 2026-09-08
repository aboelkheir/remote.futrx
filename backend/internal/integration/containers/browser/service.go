// Package browser owns legacy in-container browser operations, shared-broker
// authentication, and the agent-side browser tooling assets.
package browser

// Legacy Agent Browser provisioning brings up a real headed Chrome inside
// the project container, rendered on a virtual display (Xvfb) and exposed two
// ways onto the SAME session - a noVNC web view the user logs in through, and
// a loopback CDP port the agent drives. The launcher script
// (assets/gui-up.sh) is workspace-resident so it survives container deletes; the host
// re-pushes it whenever the embedded template changes (sha256 marker, same
// pattern as browser.mjs / AGENTS.md).

import (
	"context"

	"github.com/futrx-com/remote.futrx.com/internal/integration/containers/assets"
	"github.com/futrx-com/remote.futrx.com/internal/integration/containers/command"
	serviceprofiles "github.com/futrx-com/remote.futrx.com/internal/service/container/profiles"
	serviceproject "github.com/futrx-com/remote.futrx.com/internal/service/project"
)

// Adapter owns the raw LXD process, installation, and asset operations used by
// the browser application service. It deliberately does not decide when a
// browser stack must be provisioned before a runtime transition.
type Adapter struct {
	runner      command.Runner
	publisher   *assets.Publisher
	provisioner agentBrowserProvisioner
	runtime     agentBrowserRuntime
	mcp         agentBrowserMCPProvisioner
	config      agentBrowserConfigurator
}

// AdapterOption configures browser tooling without changing legacy callers.
type AdapterOption func(*Adapter)

// WithRemoteMCP publishes remote HTTP MCP configuration and skips installing
// a Playwright MCP process inside every project container.
func WithRemoteMCP() AdapterOption {
	return func(adapter *Adapter) {
		adapter.mcp.remote = true
	}
}

// NewAdapter returns raw browser operations backed by shared container
// dependencies.
func NewAdapter(runner command.Runner, profileSource serviceprofiles.Source, publisher *assets.Publisher, options ...AdapterOption) *Adapter {
	adapter := &Adapter{
		runner:      runner,
		publisher:   publisher,
		provisioner: agentBrowserProvisioner{runner: runner, publisher: publisher},
		runtime:     agentBrowserRuntime{runner: runner},
		mcp: agentBrowserMCPProvisioner{
			runner:    runner,
			profiles:  profileSource,
			publisher: publisher,
		},
		config: agentBrowserConfigurator{runner: runner},
	}
	for _, option := range options {
		if option != nil {
			option(adapter)
		}
	}
	return adapter
}

// Provision installs the browser stack and publishes its runtime templates.
func (a *Adapter) Provision(ctx context.Context, containerName string) error {
	return a.provisioner.ensure(ctx, containerName)
}

// Start starts the full browser core and noVNC view.
func (a *Adapter) Start(ctx context.Context, containerName string) error {
	return a.runtime.start(ctx, containerName, "start", "start agent browser")
}

// StartCore starts Xvfb, openbox, headed Chromium, and CDP without noVNC.
func (a *Adapter) StartCore(ctx context.Context, containerName string) error {
	return a.runtime.start(ctx, containerName, "start-core", "start agent browser core")
}

// StartView starts the noVNC/VNC layer on top of an existing core.
func (a *Adapter) StartView(ctx context.Context, containerName string) error {
	return a.runtime.start(ctx, containerName, "start-view", "start agent browser view")
}

// Stop tears down the browser, VNC bridge, and virtual display.
func (a *Adapter) Stop(ctx context.Context, containerName string) error {
	return a.runtime.stop(ctx, containerName)
}

// StopView tears down only the noVNC/VNC layer.
func (a *Adapter) StopView(ctx context.Context, containerName string) error {
	return a.runtime.stopView(ctx, containerName)
}

// Running reports whether the core is currently ready.
func (a *Adapter) Running(ctx context.Context, containerName string) (bool, error) {
	return a.runtime.running(ctx, containerName)
}

// Status returns the split core/view state reported by gui-up.sh.
func (a *Adapter) Status(ctx context.Context, containerName string) (serviceproject.AgentBrowserInfo, error) {
	return a.runtime.status(ctx, containerName)
}
