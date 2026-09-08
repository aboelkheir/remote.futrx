package quota

import (
	"context"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/futrx-com/remote.futrx.com/internal/agent"
)

func ownedReading() AgentQuota {
	return AgentQuota{
		Provider: "codex",
		Session:  &agent.Quota{Window: agent.QuotaWindowSession, UsedPercent: percent(20), Status: "allowed"},
		Weekly:   &agent.Quota{Window: agent.QuotaWindowWeekly, UsedPercent: percent(60), Status: "allowed_warning"},
	}
}

func corruptReading(reading AgentQuota) {
	for _, window := range []*agent.Quota{reading.Session, reading.Weekly} {
		*window.UsedPercent = 99
		window.Status = "changed"
	}
}

func assertOwnedReading(t *testing.T, service *Service) {
	t.Helper()
	want := []AgentQuota{ownedReading()}
	if got := service.View(); !reflect.DeepEqual(got, want) {
		t.Fatalf("service state changed through an external reference: got %+v, want %+v", got, want)
	}
}

func TestRecordOwnsInputAndRepositorySnapshots(t *testing.T) {
	store := &memoryStore{}
	service := New(context.Background(), store)
	input := ownedReading()
	service.Record(context.Background(), " codex ", *input.Session)
	service.Record(context.Background(), " codex ", *input.Weekly)
	corruptReading(input)
	assertOwnedReading(t, service)

	corruptReading(store.readings["codex"])
	delete(store.readings, "codex")
	assertOwnedReading(t, service)
}

func TestServiceOwnsLoadedReadings(t *testing.T) {
	store := &memoryStore{readings: map[string]AgentQuota{"codex": ownedReading()}}
	service := New(context.Background(), store)
	corruptReading(store.readings["codex"])
	delete(store.readings, "codex")
	assertOwnedReading(t, service)
}

func TestViewReturnsIndependentWindows(t *testing.T) {
	store := &memoryStore{readings: map[string]AgentQuota{"codex": ownedReading()}}
	service := New(context.Background(), store)
	view := service.View()
	corruptReading(view[0])
	view[0].Provider = "changed"
	view[0].Session = nil
	view[0].Weekly = nil
	assertOwnedReading(t, service)
}

type blockedQuotaStore struct {
	enteredFirst  chan struct{}
	enteredSecond chan struct{}
	releaseFirst  chan struct{}
	calls         atomic.Int32
	mu            sync.Mutex
	readings      map[string]AgentQuota
}

func (s *blockedQuotaStore) Load(context.Context) (map[string]AgentQuota, error) {
	return nil, nil
}

func (s *blockedQuotaStore) Save(_ context.Context, readings map[string]AgentQuota) error {
	switch s.calls.Add(1) {
	case 1:
		close(s.enteredFirst)
		<-s.releaseFirst
	case 2:
		close(s.enteredSecond)
	}
	s.mu.Lock()
	s.readings = readings
	s.mu.Unlock()
	return nil
}

func TestRecordSerializesPersistenceWithoutBlockingView(t *testing.T) {
	store := &blockedQuotaStore{
		enteredFirst: make(chan struct{}), enteredSecond: make(chan struct{}), releaseFirst: make(chan struct{}),
	}
	service := New(context.Background(), store)
	firstDone := make(chan struct{})
	go func() {
		service.Record(context.Background(), agent.ProviderCodex, agent.Quota{
			Window: agent.QuotaWindowSession, UsedPercent: percent(20),
		})
		close(firstDone)
	}()
	<-store.enteredFirst
	var release sync.Once
	defer release.Do(func() { close(store.releaseFirst) })

	viewReady := make(chan []AgentQuota, 1)
	go func() { viewReady <- service.View() }()
	select {
	case view := <-viewReady:
		if len(view) != 1 || view[0].Session == nil || *view[0].Session.UsedPercent != 20 {
			t.Fatalf("View while saving = %+v", view)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("View blocked on persistence")
	}

	secondDone := make(chan struct{})
	go func() {
		service.Record(context.Background(), agent.ProviderCodex, agent.Quota{
			Window: agent.QuotaWindowWeekly, UsedPercent: percent(60),
		})
		close(secondDone)
	}()
	select {
	case <-store.enteredSecond:
		t.Fatal("second snapshot reached persistence while the first save was unfinished")
	case <-time.After(100 * time.Millisecond):
	}
	select {
	case <-firstDone:
		t.Fatal("Record returned before its save finished")
	default:
	}
	release.Do(func() { close(store.releaseFirst) })
	for _, done := range []chan struct{}{firstDone, secondDone} {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("Record did not finish after persistence resumed")
		}
	}
	store.mu.Lock()
	saved := store.readings["codex"]
	store.mu.Unlock()
	if saved.Session == nil || saved.Weekly == nil || *saved.Session.UsedPercent != 20 || *saved.Weekly.UsedPercent != 60 {
		t.Fatalf("last persisted snapshot lost an observation: %+v", saved)
	}
	if store.calls.Load() != 2 {
		t.Fatalf("save calls = %d; want 2", store.calls.Load())
	}
}
