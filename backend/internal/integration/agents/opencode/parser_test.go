package opencode

import (
	"encoding/json"
	"testing"

	"github.com/futrx-com/remote.futrx.com/internal/agent"
)

func TestParserStreamsToolUsingTurn(t *testing.T) {
	p := NewParser(agent.RunRequest{ConversationID: "conv-1", Model: defaultModel})
	lines := []string{
		`{"type":"session.created","properties":{"info":{"id":"session-1"}}}`,
		`{"type":"message.part.updated","properties":{"part":{"id":"text-1","sessionID":"session-1","messageID":"message-1","type":"text","text":"Hello"},"delta":"Hello"}}`,
		`{"type":"message.part.updated","properties":{"part":{"id":"tool-1","sessionID":"session-1","messageID":"message-1","type":"tool","tool":"bash","state":{"status":"running","input":{"command":"ls"}}}}}`,
		`{"type":"message.part.updated","properties":{"part":{"id":"tool-1","sessionID":"session-1","messageID":"message-1","type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"ls"},"output":"main.go"}}}}`,
		`{"type":"message.part.updated","properties":{"part":{"id":"step-1","sessionID":"session-1","messageID":"message-1","type":"step-finish","tokens":{"input":12,"output":5,"reasoning":2,"cache":{"read":3,"write":1}}}}}`,
		`{"type":"session.idle","properties":{"sessionID":"session-1"}}`,
	}
	var events []agent.Event
	for _, line := range lines {
		parsed, err := p.ParseLine([]byte(line))
		if err != nil {
			t.Fatalf("ParseLine(%s): %v", line, err)
		}
		events = append(events, parsed...)
	}
	want := []agent.EventType{
		agent.EventSessionUpdated,
		agent.EventAssistantTextDelta,
		agent.EventToolStarted,
		agent.EventToolCompleted,
		agent.EventUsageUpdated,
		agent.EventRunCompleted,
	}
	if len(events) != len(want) {
		t.Fatalf("event count = %d, want %d: %#v", len(events), len(want), events)
	}
	for index, type_ := range want {
		if events[index].Type != type_ {
			t.Fatalf("event[%d] = %q, want %q", index, events[index].Type, type_)
		}
	}
	if events[1].Text != "Hello" || events[2].ToolName != "bash" || events[3].Output != "main.go" {
		t.Fatalf("unexpected streaming events: %#v", events[1:4])
	}
	var input map[string]string
	if err := json.Unmarshal(events[2].Input, &input); err != nil || input["command"] != "ls" {
		t.Fatalf("tool input = %s, err=%v", events[2].Input, err)
	}
	usage, ok := agent.ParseUsage(events[len(events)-1].Usage)
	if !ok || usage.InputTokens != 8 || usage.CacheReadTokens != 3 || usage.CacheWriteTokens != 1 || usage.OutputTokens != 5 || usage.ReasoningTokens != 2 {
		t.Fatalf("usage = %#v, parsed=%t", usage, ok)
	}
}

func TestParserUsesPartSuffixWhenOpenCodeOmitsDelta(t *testing.T) {
	p := NewParser(agent.RunRequest{ConversationID: "conv-1"})
	for _, line := range []string{
		`{"type":"message.part.updated","properties":{"part":{"id":"text-1","sessionID":"session-1","messageID":"message-1","type":"text","text":"Hello"}}}`,
		`{"type":"message.part.updated","properties":{"part":{"id":"text-1","sessionID":"session-1","messageID":"message-1","type":"text","text":"Hello world"}}}`,
	} {
		events, err := p.ParseLine([]byte(line))
		if err != nil {
			t.Fatal(err)
		}
		last := events[len(events)-1]
		if last.Type == agent.EventAssistantTextDelta && last.Text == " world" {
			return
		}
	}
	t.Fatal("parser did not emit the appended text suffix")
}
