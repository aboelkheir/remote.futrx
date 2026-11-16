package httptransport

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"time"

	serviceauth "github.com/futrx-com/remote.futrx.com/internal/service/auth"
)

// Control tokens are deliberately separate from browser sessions. The private
// file contains SHA-256 digests, never the bearer credentials themselves.
type controlTokenFile struct {
	Clients []struct {
		Name        string `json:"name"`
		TokenSHA256 string `json:"tokenSha256"`
		Email       string `json:"email"`
		Sub         string `json:"sub,omitempty"`
	} `json:"clients"`
}

func HasControlBearer(r *http.Request) bool {
	return strings.HasPrefix(strings.ToLower(r.Header.Get("Authorization")), "bearer ")
}

func ControlSession(r *http.Request) (*serviceauth.Session, error) {
	path := strings.TrimSpace(os.Getenv("REMOTE_CONTROL_TOKENS_FILE"))
	if path == "" {
		return nil, errors.New("remote control is disabled")
	}
	parts := strings.Fields(r.Header.Get("Authorization"))
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || len(parts[1]) < 32 {
		return nil, errors.New("invalid control credential")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var config controlTokenFile
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, err
	}
	digest := sha256.Sum256([]byte(parts[1]))
	for _, client := range config.Clients {
		want, err := hex.DecodeString(client.TokenSHA256)
		if err != nil || len(want) != sha256.Size || client.Name == "" || client.Email == "" {
			continue
		}
		if subtle.ConstantTimeCompare(digest[:], want) == 1 {
			now := time.Now()
			return &serviceauth.Session{Email: strings.ToLower(client.Email), Sub: client.Sub, Iat: now.Unix(), Exp: now.Add(time.Minute).Unix()}, nil
		}
	}
	return nil, errors.New("invalid control credential")
}

// ControlRouteAllowed is the complete authority of a control token. In
// particular, browser auth, admin, secrets, file, delete, and terminal routes
// cannot be reached with one.
func ControlRouteAllowed(method, path string) bool {
	switch path {
	case "/api/projects", "/api/chats":
		return method == http.MethodGet || method == http.MethodPost
	case "/api/me/settings":
		return method == http.MethodGet || method == http.MethodPatch
	case "/api/agent-capabilities":
		return method == http.MethodGet
	}
	if strings.HasPrefix(path, "/ws/chat/") {
		return method == http.MethodGet && len(strings.TrimPrefix(path, "/ws/chat/")) > 0
	}
	for _, prefix := range []string{"/api/projects/", "/api/chats/"} {
		if !strings.HasPrefix(path, prefix) {
			continue
		}
		parts := strings.Split(strings.TrimPrefix(path, prefix), "/")
		if len(parts) == 0 || parts[0] == "" {
			return false
		}
		if len(parts) == 1 {
			return method == http.MethodGet || method == http.MethodPatch
		}
		if len(parts) != 2 {
			return false
		}
		if prefix == "/api/projects/" {
			return method == http.MethodPost && (parts[1] == "start" || parts[1] == "stop" || parts[1] == "restart")
		}
		return method == http.MethodGet && (parts[1] == "events" || parts[1] == "transcript")
	}
	return false
}
