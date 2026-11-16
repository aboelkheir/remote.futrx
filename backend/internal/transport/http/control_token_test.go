package httptransport

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestControlSessionAndRouteScope(t *testing.T) {
	token := "0123456789abcdef0123456789abcdef0123456789abcdef"
	digest := sha256.Sum256([]byte(token))
	path := filepath.Join(t.TempDir(), "tokens.json")
	data := fmt.Sprintf(`{"clients":[{"name":"openclaw","tokenSha256":"%s","email":"Owner@Example.com","sub":"owner-sub"}]}`, hex.EncodeToString(digest[:]))
	if err := os.WriteFile(path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("REMOTE_CONTROL_TOKENS_FILE", path)
	req, _ := http.NewRequest(http.MethodGet, "http://example.com/api/projects", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	session, err := ControlSession(req)
	if err != nil || session.Email != "owner@example.com" || session.Sub != "owner-sub" {
		t.Fatalf("session=%+v err=%v", session, err)
	}
	req.Header.Set("Authorization", "Bearer "+token+"x")
	if _, err := ControlSession(req); err == nil {
		t.Fatal("modified token was accepted")
	}
	allowed := []struct{ method, path string }{
		{"GET", "/api/projects"}, {"POST", "/api/projects/abcd/start"}, {"PATCH", "/api/chats/abcd"}, {"GET", "/api/chats/abcd/events"}, {"GET", "/ws/chat/abcd"}, {"PATCH", "/api/me/settings"},
	}
	for _, tc := range allowed {
		if !ControlRouteAllowed(tc.method, tc.path) {
			t.Errorf("rejected %s %s", tc.method, tc.path)
		}
	}
	blocked := []struct{ method, path string }{
		{"DELETE", "/api/projects/abcd"}, {"GET", "/api/projects/abcd/secrets"}, {"POST", "/api/admin/users"}, {"GET", "/ws/terminal"}, {"POST", "/api/chats/abcd/fork"}, {"GET", "/auth/me"},
	}
	for _, tc := range blocked {
		if ControlRouteAllowed(tc.method, tc.path) {
			t.Errorf("allowed %s %s", tc.method, tc.path)
		}
	}
}
