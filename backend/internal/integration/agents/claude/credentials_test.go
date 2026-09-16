package claude

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAuthenticatedRequiresUsableOAuthCredentials(t *testing.T) {
	tests := []struct {
		name string
		data string
		want bool
	}{
		{"cleared after rejected refresh", `{"claudeAiOauth":{"scopes":["user:inference"]}}`, false},
		{"null tokens", `{"claudeAiOauth":{"accessToken":null,"refreshToken":null,"expiresAt":null}}`, false},
		{"empty tokens", `{"claudeAiOauth":{"accessToken":" ","refreshToken":" "}}`, false},
		{"malformed file", `{"claudeAiOauth":`, false},
		{"unrelated credentials", `{"mcpOAuth":{"accessToken":"mcp-only"}}`, false},
		{"expired access without refresh", `{"claudeAiOauth":{"accessToken":"expired","expiresAt":1}}`, false},
		{"access without expiry or refresh", `{"claudeAiOauth":{"accessToken":"unknown-expiry"}}`, false},
		{"expired but refreshable", `{"claudeAiOauth":{"accessToken":"expired","refreshToken":"refresh","expiresAt":1}}`, true},
		{"refresh only", `{"claudeAiOauth":{"refreshToken":"refresh"}}`, true},
		{"unexpired access", `{"claudeAiOauth":{"accessToken":"access","expiresAt":4102444800000}}`, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("CLAUDE_CONFIG_DIR", dir)
			if err := os.WriteFile(filepath.Join(dir, ".credentials.json"), []byte(tt.data), 0o600); err != nil {
				t.Fatal(err)
			}
			if got := authenticated(); got != tt.want {
				t.Fatalf("authenticated = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestAuthenticatedCredentialFilePrecedence(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	if authenticated() {
		t.Fatal("missing credentials reported as authenticated")
	}
	if err := os.WriteFile(filepath.Join(dir, "credentials.json"), []byte(`{"claudeAiOauth":{"refreshToken":"legacy"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if !authenticated() {
		t.Fatal("legacy credential filename was not recognized")
	}
	if err := os.WriteFile(filepath.Join(dir, ".credentials.json"), []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if authenticated() {
		t.Fatal("legacy file masked cleared primary credentials")
	}
}
