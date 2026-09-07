package codex

import (
	"encoding/json"

	"github.com/futrx-com/remote.futrx.com/internal/agent"
)

// codexRateLimits is the rate_limits block on a token_count event. Codex names
// its windows by position — primary is the short one, secondary the long — and
// gives each a percentage and a length rather than a reset time.
type codexRateLimits struct {
	Primary   *codexRateWindow `json:"primary_window"`
	Secondary *codexRateWindow `json:"secondary_window"`
}

type codexRateWindow struct {
	UsedPercent     *float64 `json:"used_percent"`
	ResetsInSeconds *int64   `json:"resets_in_seconds"`
}

// quotaEvents turns codex's two windows into platform readings.
//
// Codex reports how long the window is rather than when it ends, so the reset
// time is computed here. That makes it a clock reading rather than the vendor's
// own timestamp, which is fine for a countdown and is why the reading also
// carries when it was measured.
func (p *Parser) quotaEvents(now int64, rawLine []byte, limits json.RawMessage) []agent.Event {
	if len(limits) == 0 {
		return nil
	}
	var parsed codexRateLimits
	if err := json.Unmarshal(limits, &parsed); err != nil {
		return nil
	}

	events := make([]agent.Event, 0, 2)
	for _, pair := range []struct {
		window agent.QuotaWindow
		source *codexRateWindow
	}{
		{agent.QuotaWindowSession, parsed.Primary},
		{agent.QuotaWindowWeekly, parsed.Secondary},
	} {
		if pair.source == nil {
			continue
		}
		quota := agent.Quota{
			Window:      pair.window,
			UsedPercent: pair.source.UsedPercent,
			MeasuredAt:  now,
		}
		if pair.source.ResetsInSeconds != nil && *pair.source.ResetsInSeconds > 0 {
			quota.ResetsAt = now/1000 + *pair.source.ResetsInSeconds
		}
		events = append(events, p.event(now, agent.EventQuotaUpdated, rawLine, func(ev *agent.Event) {
			ev.Quota = &quota
		}))
	}
	return events
}
