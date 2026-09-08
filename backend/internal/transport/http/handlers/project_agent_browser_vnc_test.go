package httphandlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	serviceproject "github.com/futrx-com/remote.futrx.com/internal/service/project"
	"github.com/gorilla/websocket"
)

func TestProjectAgentBrowserVNCProxy(t *testing.T) {
	observed := make(chan string, 2)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer scoped-vnc-token" || r.Header.Get("Cookie") != "" {
			t.Error("VNC proxy did not replace credentials")
		}
		observed <- r.URL.RequestURI()
		connection, err := (&websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		_ = connection.WriteMessage(websocket.BinaryMessage, []byte("RFB 003.008\n"))
	}))
	defer upstream.Close()
	handler, project := newSharedAgentBrowserProjectHandler(t, serviceproject.AgentBrowserViewTarget{
		URL: upstream.URL + "/view", BearerToken: "scoped-vnc-token",
	})
	application := httptest.NewServer(http.HandlerFunc(handler.HandleResource))
	defer application.Close()
	base := "ws" + strings.TrimPrefix(application.URL, "http") + "/api/projects/" + string(project.ID) + "/agent-browser/view"
	header := http.Header{"Origin": {application.URL}, "Cookie": {"remote_session=private"}}
	const viewer = "0cf6fe40-0e5c-45b9-a503-096f2b127fe7"
	for _, transport := range []string{"vnc", "control"} {
		connection, _, err := websocket.DefaultDialer.Dial(base+"?transport="+transport+"&viewer="+viewer+"&target=other-project&token=untrusted", header)
		if err != nil {
			t.Fatal(err)
		}
		kind, payload, err := connection.ReadMessage()
		connection.Close()
		if err != nil || kind != websocket.BinaryMessage || string(payload) != "RFB 003.008\n" {
			t.Fatalf("binary proxy: kind=%d payload=%q error=%v", kind, payload, err)
		}
		if got, want := <-observed, "/view?transport="+transport+"&viewer="+viewer; got != want {
			t.Fatalf("upstream URI=%q want %q", got, want)
		}
	}
	for _, query := range []string{"transport=cdp&viewer=" + viewer, "transport=vnc&viewer=../../beta", "transport=control"} {
		connection, response, err := websocket.DefaultDialer.Dial(base+"?"+query, header)
		if connection != nil {
			connection.Close()
		}
		if err == nil || response == nil || response.StatusCode != http.StatusBadRequest {
			t.Fatalf("invalid transport accepted: query=%q error=%v", query, err)
		}
		response.Body.Close()
	}
}
