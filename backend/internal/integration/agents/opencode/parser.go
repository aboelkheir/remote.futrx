package opencode

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/futrx-com/remote.futrx.com/internal/agent"
)

// Parser translates OpenCode's --format json event stream into Remote's
// provider-neutral chat events. Text/reasoning parts are updated in place by
// OpenCode, so the parser emits only their appended suffix when delta is absent.
type Parser struct {
	req       agent.RunRequest
	sessionID string
	text      map[string]string
	started   map[string]bool
	completed bool
	failed    bool
	usage     agent.Usage
}

func NewParser(req agent.RunRequest) *Parser {
	if req.Provider == "" {
		req.Provider = agent.ProviderOpenCode
	}
	return &Parser{
		req:       req,
		sessionID: req.ResumeID,
		text:      map[string]string{},
		started:   map[string]bool{},
	}
}

type wireEvent struct {
	Type       string          `json:"type"`
	Properties json.RawMessage `json:"properties"`
	// The non-interactive `opencode run --format json` CLI writes a compact
	// event stream. Unlike the server event bus, its parts live directly at
	// the event root (for example `{"type":"text","part":{...}}`).
	// Retain both shapes: the former is used by the server, the latter by the
	// command that Remote actually runs in project containers.
	SessionID string          `json:"sessionID"`
	Part      json.RawMessage `json:"part"`
	Error     json.RawMessage `json:"error"`
}

type partUpdate struct {
	Part  wirePart `json:"part"`
	Delta string   `json:"delta"`
}

type wirePart struct {
	ID        string          `json:"id"`
	SessionID string          `json:"sessionID"`
	MessageID string          `json:"messageID"`
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Tool      string          `json:"tool"`
	State     json.RawMessage `json:"state"`
	Tokens    *struct {
		Input     int64 `json:"input"`
		Output    int64 `json:"output"`
		Reasoning int64 `json:"reasoning"`
		Cache     struct {
			Read  int64 `json:"read"`
			Write int64 `json:"write"`
		} `json:"cache"`
	} `json:"tokens"`
}

func (p *Parser) ParseLine(line []byte) ([]agent.Event, error) {
	raw := append(json.RawMessage(nil), line...)
	var event wireEvent
	if err := json.Unmarshal(line, &event); err != nil {
		return nil, err
	}
	now := time.Now().UnixMilli()
	switch event.Type {
	case "step_start", "text", "tool_use", "step_finish":
		return p.cliPartEvents(now, raw, event)
	case "error":
		message := errorMessage(event.Error)
		if message == "OpenCode session failed" {
			message = "OpenCode run failed"
		}
		p.failed = true
		events := p.sessionEvents(now, raw, event.SessionID)
		events = append(events, p.event(now, agent.EventRunFailed, raw, func(ev *agent.Event) {
			ev.Message = message
		}))
		return events, nil
	case "session.created", "session.updated":
		var properties struct {
			Info struct {
				ID string `json:"id"`
			} `json:"info"`
		}
		if err := json.Unmarshal(event.Properties, &properties); err != nil {
			return nil, err
		}
		return p.sessionEvents(now, raw, properties.Info.ID), nil
	case "message.part.updated":
		var properties partUpdate
		if err := json.Unmarshal(event.Properties, &properties); err != nil {
			return nil, err
		}
		return p.partEvents(now, raw, properties), nil
	case "session.idle":
		var properties struct {
			SessionID string `json:"sessionID"`
		}
		if err := json.Unmarshal(event.Properties, &properties); err != nil {
			return nil, err
		}
		events := p.sessionEvents(now, raw, properties.SessionID)
		if completed, ok := p.Complete(); ok {
			completed.Raw = raw
			events = append(events, completed)
		}
		return events, nil
	case "session.error":
		var properties struct {
			SessionID string          `json:"sessionID"`
			Error     json.RawMessage `json:"error"`
		}
		if err := json.Unmarshal(event.Properties, &properties); err != nil {
			return nil, err
		}
		p.failed = true
		events := p.sessionEvents(now, raw, properties.SessionID)
		message := errorMessage(properties.Error)
		events = append(events, p.event(now, agent.EventRunFailed, raw, func(ev *agent.Event) { ev.Message = message }))
		return events, nil
	}
	return nil, nil
}

// Complete returns the terminal event after the CLI exits successfully.
// The CLI JSON stream ends at a step boundary and does not emit an explicit
// session-idle record, so step-finish is not a safe completion signal when an
// agent still has tools to call.
func (p *Parser) Complete() (agent.Event, bool) {
	if p.completed || p.failed {
		return agent.Event{}, false
	}
	p.completed = true
	return p.event(time.Now().UnixMilli(), agent.EventRunCompleted, nil, nil), true
}

// cliPartEvents adapts the documented JSONL output from `opencode run`.
// `step_start` has no user-visible effect but is the earliest reliable place
// to capture the session ID for later resume/fork requests.
func (p *Parser) cliPartEvents(now int64, raw json.RawMessage, event wireEvent) ([]agent.Event, error) {
	if len(event.Part) == 0 {
		return p.sessionEvents(now, raw, event.SessionID), nil
	}
	var part wirePart
	if err := json.Unmarshal(event.Part, &part); err != nil {
		return nil, err
	}
	if part.SessionID == "" {
		part.SessionID = event.SessionID
	}
	if event.Type == "step_start" {
		return p.sessionEvents(now, raw, part.SessionID), nil
	}
	return p.partEvents(now, raw, partUpdate{Part: part}), nil
}

func (p *Parser) sessionEvents(now int64, raw json.RawMessage, id string) []agent.Event {
	if id == "" || id == p.sessionID {
		return nil
	}
	p.sessionID = id
	return []agent.Event{p.event(now, agent.EventSessionUpdated, raw, func(ev *agent.Event) {
		ev.SessionID = id
	})}
}

func (p *Parser) partEvents(now int64, raw json.RawMessage, update partUpdate) []agent.Event {
	part := update.Part
	events := p.sessionEvents(now, raw, part.SessionID)
	switch part.Type {
	case "text", "reasoning":
		delta := update.Delta
		if delta == "" {
			previous := p.text[part.ID]
			if strings.HasPrefix(part.Text, previous) {
				delta = strings.TrimPrefix(part.Text, previous)
			} else {
				delta = part.Text
			}
		}
		p.text[part.ID] = part.Text
		if delta == "" {
			return events
		}
		type_ := agent.EventAssistantTextDelta
		kind := agent.ItemMessage
		if part.Type == "reasoning" {
			type_, kind = agent.EventReasoningDelta, agent.ItemReasoning
		}
		events = append(events, p.event(now, type_, raw, func(ev *agent.Event) {
			ev.ItemID, ev.MessageID, ev.ItemKind, ev.Text = part.ID, part.MessageID, kind, delta
		}))
	case "tool":
		var state struct {
			Status string          `json:"status"`
			Input  json.RawMessage `json:"input"`
			Output string          `json:"output"`
			Error  string          `json:"error"`
		}
		if err := json.Unmarshal(part.State, &state); err != nil {
			return events
		}
		if (state.Status == "pending" || state.Status == "running") && !p.started[part.ID] {
			p.started[part.ID] = true
			events = append(events, p.event(now, agent.EventToolStarted, raw, func(ev *agent.Event) {
				ev.ItemID, ev.MessageID, ev.ItemKind, ev.ToolName, ev.Input = part.ID, part.MessageID, agent.ItemToolCall, part.Tool, state.Input
			}))
		}
		if state.Status == "completed" || state.Status == "error" {
			events = append(events, p.event(now, agent.EventToolCompleted, raw, func(ev *agent.Event) {
				ev.ItemID, ev.MessageID, ev.ItemKind, ev.Output, ev.IsError = part.ID, part.MessageID, agent.ItemToolCall, state.Output, state.Status == "error"
				if ev.IsError {
					ev.Output = state.Error
				}
			}))
		}
	case "step-finish":
		if part.Tokens != nil {
			p.usage = agent.NormalizeInclusiveInput(agent.Usage{
				InputTokens:      part.Tokens.Input,
				OutputTokens:     part.Tokens.Output,
				ReasoningTokens:  part.Tokens.Reasoning,
				CacheReadTokens:  part.Tokens.Cache.Read,
				CacheWriteTokens: part.Tokens.Cache.Write,
				Model:            normalizeModel(p.req.Model),
			})
			events = append(events, p.event(now, agent.EventUsageUpdated, raw, func(ev *agent.Event) {
				ev.Usage = p.usage.Raw()
			}))
		}
	}
	return events
}

func (p *Parser) event(now int64, type_ agent.EventType, raw json.RawMessage, fn func(*agent.Event)) agent.Event {
	ev := agent.Event{
		T:              now,
		Type:           type_,
		Provider:       agent.ProviderOpenCode,
		ConversationID: p.req.ConversationID,
		Raw:            raw,
	}
	if type_ == agent.EventRunCompleted {
		ev.Usage = p.usage.Raw()
	}
	if fn != nil {
		fn(&ev)
	}
	return ev
}

func errorMessage(raw json.RawMessage) string {
	if len(raw) == 0 {
		return "OpenCode session failed"
	}
	var value struct {
		Message string `json:"message"`
		Data    struct {
			Message string `json:"message"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &value) == nil {
		if value.Message != "" {
			return value.Message
		}
		if value.Data.Message != "" {
			return value.Data.Message
		}
	}
	return "OpenCode session failed"
}
