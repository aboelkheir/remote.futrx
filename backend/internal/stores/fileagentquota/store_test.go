package fileagentquota

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/futrx-com/remote.futrx.com/internal/agent"
	agentquota "github.com/futrx-com/remote.futrx.com/internal/service/agent/quota"
)

func TestLoadFallbacks(t *testing.T) {
	for _, test := range []struct {
		name string
		raw  string
	}{
		{name: "missing"}, {name: "unreadable"}, {name: "empty"},
		{name: "malformed", raw: "{"}, {name: "null", raw: "null"},
	} {
		t.Run(test.name, func(t *testing.T) {
			store, err := New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			switch test.name {
			case "missing":
			case "unreadable":
				err = os.Mkdir(store.path(), 0o700)
			default:
				err = os.WriteFile(store.path(), []byte(test.raw), 0o600)
			}
			if err != nil {
				t.Fatal(err)
			}
			readings, err := store.Load(context.Background())
			if err != nil || len(readings) != 0 || (readings == nil) != (test.name == "null") {
				t.Fatalf("Load = %#v, %v", readings, err)
			}
		})
	}
}

func TestSaveRoundTripAndPermissions(t *testing.T) {
	root := filepath.Join(t.TempDir(), "data")
	store, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	zero := 0.0
	want := map[string]agentquota.AgentQuota{
		"codex": {Provider: "codex", Session: &agent.Quota{
			Window: agent.QuotaWindowSession, UsedPercent: &zero, MeasuredAt: 123,
		}},
	}
	if err := store.Save(context.Background(), want); err != nil {
		t.Fatal(err)
	}
	got, err := store.Load(context.Background())
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("round trip = %#v, %v; want %#v", got, err, want)
	}
	for path, mode := range map[string]os.FileMode{root: 0o700, store.path(): 0o600} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != mode {
			t.Fatalf("%s mode = %o; want %o", path, info.Mode().Perm(), mode)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := store.Save(ctx, nil); err != context.Canceled {
		t.Fatalf("cancelled Save = %v", err)
	}
	if _, err := store.Load(ctx); err != context.Canceled {
		t.Fatalf("cancelled Load = %v", err)
	}
}
