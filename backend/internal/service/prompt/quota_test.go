package prompt

import (
	"context"
	"testing"

	"github.com/futrx-com/remote.futrx.com/internal/agent"
)

type recordingQuota struct {
	contexts []context.Context
	readings []agent.Quota
	provider agent.ProviderID
}

func (r *recordingQuota) Record(ctx context.Context, provider agent.ProviderID, quota agent.Quota) {
	r.contexts = append(r.contexts, ctx)
	r.readings = append(r.readings, quota)
	r.provider = provider
}

func TestRecordQuotaPreservesValuesWithoutCancellation(t *testing.T) {
	type contextKey struct{}
	live, cancelLive := context.WithCancel(context.WithValue(context.Background(), contextKey{}, "run"))
	defer cancelLive()
	cancelled, cancel := context.WithCancel(live)
	cancel()
	for _, ctx := range []context.Context{nil, live, cancelled} {
		recorder := &recordingQuota{}
		service := &Service{quota: recorder}
		reading := agent.Quota{Window: agent.QuotaWindowSession, MeasuredAt: 123}
		service.recordQuota(ctx, agent.Event{Type: agent.EventQuotaUpdated, Provider: agent.ProviderCodex, Quota: &reading})
		if len(recorder.readings) != 1 || recorder.readings[0] != reading || recorder.provider != agent.ProviderCodex {
			t.Fatalf("recorded = %+v", recorder)
		}
		got := recorder.contexts[0]
		if got.Err() != nil {
			t.Fatalf("recording context is cancelled: %v", got.Err())
		}
		if ctx != nil && got.Value(contextKey{}) != "run" {
			t.Fatal("recording context lost request values")
		}
		if got.Done() != nil {
			t.Fatal("a later prompt cancellation can still cancel quota persistence")
		}
	}
}

func TestRecordQuotaDropsOtherEventsAndMissingReadings(t *testing.T) {
	recorder := &recordingQuota{}
	service := &Service{quota: recorder}
	reading := &agent.Quota{Window: agent.QuotaWindowWeekly}
	service.recordQuota(context.Background(), agent.Event{Type: agent.EventRunCompleted, Quota: reading})
	service.recordQuota(context.Background(), agent.Event{Type: agent.EventQuotaUpdated})
	if len(recorder.readings) != 0 {
		t.Fatalf("unexpected readings: %+v", recorder.readings)
	}
	service.quota = nil
	service.recordQuota(context.Background(), agent.Event{Type: agent.EventQuotaUpdated, Quota: reading})
	if _, ok := chatEventFromAgentEvent(agent.Event{Type: agent.EventQuotaUpdated, Quota: reading}); ok {
		t.Fatal("quota observation must not become a persisted chat event")
	}
}
