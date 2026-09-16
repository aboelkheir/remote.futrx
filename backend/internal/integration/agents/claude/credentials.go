package claude

import (
	"encoding/json"
	"strings"
	"time"
)

type oauthCredentialValidator struct{}

func (oauthCredentialValidator) Valid(data []byte) bool {
	var credentials struct {
		OAuth struct {
			AccessToken  string `json:"accessToken"`
			RefreshToken string `json:"refreshToken"`
			ExpiresAt    int64  `json:"expiresAt"`
		} `json:"claudeAiOauth"`
	}
	if err := json.Unmarshal(data, &credentials); err != nil {
		return false
	}
	oauth := credentials.OAuth
	// Access-token expiry is normal when a refresh token is available. Claude
	// retains metadata after a rejected refresh, so file existence is not enough.
	return strings.TrimSpace(oauth.RefreshToken) != "" ||
		(strings.TrimSpace(oauth.AccessToken) != "" && oauth.ExpiresAt > time.Now().UnixMilli())
}
