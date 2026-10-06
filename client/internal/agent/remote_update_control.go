package agent

import "context"

const rememberedUpdateRequests = 16

type remoteUpdateAck struct {
	Type      string `json:"type"`
	RequestID string `json:"request_id"`
	State     string `json:"state"`
	Code      string `json:"code,omitempty"`
}

// Only a small replay window survives reconnections; the signed server-side
// claim remains authoritative even when a request has left this window.
type remoteUpdateControl struct {
	recent  [rememberedUpdateRequests]remoteUpdateAck
	next    int
	trigger func(context.Context, string) error
}

func validUpdateRequestID(value string) bool {
	if len(value) != 32 {
		return false
	}
	for _, c := range value {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func (r *remoteUpdateControl) find(id string) (remoteUpdateAck, bool) {
	for _, ack := range r.recent {
		if ack.RequestID == id {
			return ack, true
		}
	}
	return remoteUpdateAck{}, false
}

func (r *remoteUpdateControl) remember(ack remoteUpdateAck) {
	r.recent[r.next] = ack
	r.next = (r.next + 1) % len(r.recent)
}

func (r *remoteUpdateControl) start(ctx context.Context, configPath, id string) remoteUpdateAck {
	ack := remoteUpdateAck{Type: "update_ack", RequestID: id, State: "failed", Code: "update_trigger_failed"}
	if configPath == "" {
		return ack
	}
	trigger := r.trigger
	if trigger == nil {
		trigger = TriggerRemoteUpdate
	}
	if trigger(ctx, configPath) == nil {
		ack.State, ack.Code = "accepted", ""
	}
	return ack
}
