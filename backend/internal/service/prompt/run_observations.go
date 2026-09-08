package prompt

import (
	"context"
	crand "crypto/rand"
	"encoding/hex"
	"strconv"
	"time"

	"github.com/futrx-com/remote.futrx.com/internal/agent"
	servicechat "github.com/futrx-com/remote.futrx.com/internal/service/chat"
	serviceusage "github.com/futrx-com/remote.futrx.com/internal/service/usage"
)

// UsageRecorder receives one entry per completed agent run. It is the only
// thing the prompt service knows about token accounting; pricing, storage and
// aggregation all live in the usage service.
type UsageRecorder interface {
	RecordRun(ctx context.Context, event serviceusage.RunEvent)
}

// QuotaRecorder files the subscription windows the agent CLIs volunteer. It is
// optional: without one the readings are dropped and the dashboard has no plan
// card, which is the behaviour before this existed.
type QuotaRecorder interface {
	Record(ctx context.Context, provider agent.ProviderID, quota agent.Quota)
}

func WithUsageRecorder(recorder UsageRecorder) Option {
	return func(service *Service) {
		service.usage = recorder
	}
}

// WithQuotaRecorder installs the recipient of provider quota observations.
func WithQuotaRecorder(recorder QuotaRecorder) Option {
	return func(service *Service) {
		service.quota = recorder
	}
}

// ledgerRun is the run-scoped context a usage entry needs. It is captured
// once per prompt so the per-event hook stays allocation free.
type ledgerRun struct {
	runID     string
	chatID    servicechat.ID
	projectID string
	userEmail string
	model     string
	scheduled bool
}

// recordQuota files a subscription window the CLI mentioned mid-run.
//
// It is separate from recordRunUsage because the two measure different things:
// the ledger counts what this platform spent, and this is the vendor saying
// how much of the operator's plan is left across everywhere they work.
func (rnr *Service) recordQuota(ctx context.Context, ev agent.Event) {
	if rnr.quota == nil || ev.Type != agent.EventQuotaUpdated || ev.Quota == nil {
		return
	}
	// A cancelled request context must not throw away a reading that arrived
	// before the cancel: the window is real whether or not the turn finished.
	if ctx == nil {
		ctx = context.Background()
	}
	rnr.quota.Record(context.WithoutCancel(ctx), ev.Provider, *ev.Quota)
}

// recordRunUsage forwards a finished turn to the usage ledger. Only completed
// runs are recorded: a failed turn's token counts are not persisted in the
// chat event log, so counting them here would make the ledger impossible to
// rebuild from disk.
func (rnr *Service) recordRunUsage(ctx context.Context, run ledgerRun, ev agent.Event) {
	if rnr.usage == nil || ev.Type != agent.EventRunCompleted {
		return
	}
	at := ev.T
	if at == 0 {
		at = time.Now().UnixMilli()
	}
	// The turn is over, so a cancelled request context must not stop the
	// ledger write that describes it.
	rnr.usage.RecordRun(context.WithoutCancel(ctx), serviceusage.RunEvent{
		At:        at,
		ChatID:    string(run.chatID),
		ProjectID: run.projectID,
		RunID:     run.runID,
		UserEmail: run.userEmail,
		Provider:  string(ev.Provider),
		Model:     run.model,
		Usage:     ev.Usage,
		Scheduled: run.scheduled,
	})
}

// newLedgerRunID identifies one prompt run across the events it produces.
func newLedgerRunID() string {
	var raw [8]byte
	if _, err := crand.Read(raw[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return hex.EncodeToString(raw[:])
}
