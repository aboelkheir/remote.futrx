package codexharness

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"reflect"
	"testing"
	"time"

	"github.com/futrx-com/remote.futrx.com/internal/agent"
)

func TestCodexQuotaReadingsSelectProductAndWindowDuration(t *testing.T) {
	const now = int64(1787563000123)
	for _, test := range []struct {
		name string
		raw  string
		want []agent.Quota
	}{
		{
			name: "absolute reset and duration determine windows",
			raw:  `{"rateLimits":{"limitId":"codex","primary":{"usedPercent":80,"windowDurationMins":10080,"resetsAt":1788000000},"secondary":{"usedPercent":0,"windowDurationMins":300,"resetsAt":1787563200}}}`,
			want: []agent.Quota{quotaReading(agent.QuotaWindowSession, 0, 1787563200, now), quotaReading(agent.QuotaWindowWeekly, 80, 1788000000, now)},
		},
		{
			name: "weekly only primary",
			raw:  `{"rateLimits":{"limitId":"codex","primary":{"usedPercent":0,"windowDurationMins":10080,"resetsAt":1788000000}}}`,
			want: []agent.Quota{quotaReading(agent.QuotaWindowWeekly, 0, 1788000000, now)},
		},
		{
			name: "legacy bucket without identity",
			raw:  `{"rateLimits":{"primary":{"usedPercent":12.5,"windowDurationMins":300,"resetsAt":null}}}`,
			want: []agent.Quota{quotaReading(agent.QuotaWindowSession, 12.5, 0, now)},
		},
		{
			name: "codex map bucket overrides legacy and unrelated products",
			raw:  `{"rateLimits":{"limitId":"codex_other","primary":{"usedPercent":99,"windowDurationMins":300}},"rateLimitsByLimitId":{"codex":{"limitId":"codex","primary":{"usedPercent":10,"windowDurationMins":300}},"other":"invalid unrelated product"}}`,
			want: []agent.Quota{quotaReading(agent.QuotaWindowSession, 10, 0, now)},
		},
		{
			name: "duplicate duration emits only first reading",
			raw:  `{"rateLimits":{"primary":{"usedPercent":10,"windowDurationMins":300},"secondary":{"usedPercent":20,"windowDurationMins":300}}}`,
			want: []agent.Quota{quotaReading(agent.QuotaWindowSession, 10, 0, now)},
		},
		{name: "explicit other product", raw: `{"rateLimits":{"limitId":"codex_other","primary":{"usedPercent":20,"windowDurationMins":300}}}`},
		{name: "map without codex has no fallback", raw: `{"rateLimits":{"primary":{"usedPercent":20,"windowDurationMins":300}},"rateLimitsByLimitId":{"other":{}}}`},
		{name: "mismatched map identity", raw: `{"rateLimitsByLimitId":{"codex":{"limitId":"other","primary":{"usedPercent":20,"windowDurationMins":300}}}}`},
		{name: "unknown durations", raw: `{"rateLimits":{"primary":{"usedPercent":20,"windowDurationMins":15},"secondary":{"usedPercent":20,"windowDurationMins":43200}}}`},
		{name: "missing duration", raw: `{"rateLimits":{"primary":{"usedPercent":20}}}`},
		{name: "missing percentage", raw: `{"rateLimits":{"primary":{"windowDurationMins":300}}}`},
		{name: "negative percentage", raw: `{"rateLimits":{"primary":{"usedPercent":-1,"windowDurationMins":300}}}`},
		{name: "missing payload", raw: `{}`},
		{name: "null payload", raw: `{"rateLimits":null}`},
		{name: "malformed payload", raw: `{"rateLimits":"not an object"}`},
		{name: "wrong number type", raw: `{"rateLimits":{"primary":{"usedPercent":"20","windowDurationMins":300}}}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := codexQuotaReadings(json.RawMessage(test.raw), now); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("readings = %#v; want %#v", got, test.want)
			}
		})
	}
}

func quotaReading(window agent.QuotaWindow, percent float64, reset, measured int64) agent.Quota {
	return agent.Quota{Window: window, UsedPercent: &percent, ResetsAt: reset, MeasuredAt: measured}
}

func TestAppServerQuotaNotificationPreservesNativeEventAndUsage(t *testing.T) {
	parser := newAppServerEventParser(agent.RunRequest{Provider: agent.ProviderCodex, ConversationID: "chat-1"}, "Codex")
	parser.ParseNotification("thread/tokenUsage/updated", json.RawMessage(`{"tokenUsage":{"last":{"inputTokens":10,"outputTokens":4}}}`))
	raw := json.RawMessage(`{"rateLimits":{"limitId":"codex","primary":{"usedPercent":25,"windowDurationMins":300,"resetsAt":1787563200}}}`)
	events := parser.ParseNotification("account/rateLimits/updated", raw)
	if len(events) != 2 || events[0].Type != agent.EventProviderNative || events[1].Type != agent.EventQuotaUpdated {
		t.Fatalf("events = %#v", events)
	}
	for _, event := range events {
		if event.Provider != agent.ProviderCodex || event.ConversationID != "chat-1" || event.Native == nil || event.Native.Method != "account/rateLimits/updated" || string(event.Raw) != string(raw) {
			t.Fatalf("event identity or native payload lost: %#v", event)
		}
	}
	if string(events[0].Data) != string(raw) || events[1].Quota == nil || events[1].Quota.MeasuredAt != events[1].T {
		t.Fatalf("native data or measured time lost: %#v", events)
	}
	completed := parser.ParseNotification("turn/completed", json.RawMessage(`{"turn":{"status":"completed"}}`))
	usage, ok := agent.ParseUsage(completed[0].Usage)
	if !ok || usage.InputTokens != 10 || usage.OutputTokens != 4 {
		t.Fatalf("quota replaced token usage: %#v", usage)
	}

	for _, provider := range []agent.ProviderID{agent.ProviderCodex, agent.ProviderMiniMax} {
		parser := newAppServerEventParser(agent.RunRequest{Provider: provider}, string(provider))
		payload := raw
		if provider == agent.ProviderCodex {
			payload = json.RawMessage(`{"rateLimits":"malformed"}`)
		}
		if events := parser.ParseNotification("account/rateLimits/updated", payload); len(events) != 1 || events[0].Type != agent.EventProviderNative {
			t.Fatalf("invalid or unrelated-provider quota changed native fallback: %#v", events)
		}
	}
}

func TestRunAppServerInitialQuotaIsBestEffort(t *testing.T) {
	for _, test := range []struct {
		name, replies string
		want          []float64
	}{
		{name: "initial account snapshot", replies: `printf '%s\n' '{"id":5,"result":{"rateLimits":{"limitId":"codex","primary":{"usedPercent":10,"windowDurationMins":300}}}}'`, want: []float64{10}},
		{name: "initial response cannot overwrite live window", replies: `printf '%s\n' '{"method":"account/rateLimits/updated","params":{"rateLimits":{"limitId":"codex","primary":{"usedPercent":40,"windowDurationMins":300}}}}'
printf '%s\n' '{"id":5,"result":{"rateLimits":{"limitId":"codex","primary":{"usedPercent":10,"windowDurationMins":300},"secondary":{"usedPercent":80,"windowDurationMins":10080}}}}'`, want: []float64{40, 80}},
		{name: "unsupported request", replies: `printf '%s\n' '{"id":5,"error":{"code":-32601,"message":"method not found"}}'`},
		{name: "account unavailable", replies: `printf '%s\n' '{"id":5,"error":{"code":-1,"message":"authentication required"}}'`},
		{name: "malformed reading", replies: `printf '%s\n' '{"id":5,"result":{"rateLimits":"invalid"}}'`},
		{name: "unanswered request", replies: `:`},
		{name: "late response after turn completion", replies: `printf '%s\n' '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}'
printf '%s\n' '{"id":5,"error":{"code":-1,"message":"late quota failure"}}'`},
	} {
		t.Run(test.name, func(t *testing.T) {
			script := fmt.Sprintf(`
started=
while IFS= read -r line; do
 case "$line" in
  *'"id":1'*) printf '%%s\n' '{"id":1,"result":{}}' ;;
  *'"id":2'*) printf '%%s\n' '{"id":2,"result":{"thread":{"id":"thread-1"},"model":"gpt-test"}}' ;;
  *'"id":3'*)
   started=yes
   printf '%%s\n' '{"id":3,"result":{"turn":{"id":"turn-1","status":"inProgress"}}}'
   printf '%%s\n' '{"method":"item/agentMessage/delta","params":{"itemId":"message-1","delta":"working"}}'
   ;;
  *'"id":5'*)
   test "$started" = yes || exit 10
   case "$line" in *'"method":"account/rateLimits/read"'*) ;; *) exit 11 ;; esac
   %s
   printf '%%s\n' '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}'
   exit 0
   ;;
 esac
done`, test.replies)
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			var events []agent.Event
			err := Run(ctx, exec.CommandContext(ctx, "sh", "-c", script), agent.RunRequest{Provider: agent.ProviderCodex, ConversationID: "chat-1", Prompt: "work"}, "Codex", func(event agent.Event) { events = append(events, event) })
			if err != nil {
				t.Fatal(err)
			}
			var percentages []float64
			var text string
			for _, event := range events {
				if event.Type == agent.EventQuotaUpdated {
					percentages = append(percentages, *event.Quota.UsedPercent)
				}
				if event.Type == agent.EventAssistantTextDelta {
					text += event.Text
				}
				if event.Type == agent.EventRunFailed || event.Type == agent.EventError {
					t.Fatalf("quota failed the prompt: %#v", event)
				}
			}
			if !reflect.DeepEqual(percentages, test.want) || text != "working" || events[len(events)-1].Type != agent.EventRunCompleted {
				t.Fatalf("percentages = %v; want %v; events = %#v", percentages, test.want, events)
			}
		})
	}
}

func TestMiniMaxDoesNotReadCodexAccountQuota(t *testing.T) {
	run := &appServerRun{req: agent.RunRequest{Provider: agent.ProviderMiniMax}}
	run.requestInitialQuota() // No process exists: a request here would panic.
	if run.quotaReadPending {
		t.Fatal("unrelated provider scheduled a Codex account read")
	}
}
