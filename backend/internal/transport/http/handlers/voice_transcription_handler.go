package httphandlers

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"path/filepath"
	"strings"
	"time"

	serviceauth "github.com/futrx-com/remote.futrx.com/internal/service/auth"
	"github.com/futrx-com/remote.futrx.com/internal/stores/fileauth"
	httptransport "github.com/futrx-com/remote.futrx.com/internal/transport/http"
)

const maxVoiceBytes = 25 << 20

type VoiceTranscriptionHandler struct {
	store    *fileauth.Store
	auth     *serviceauth.Service
	client   *http.Client
	endpoint string
}

func NewVoiceTranscriptionHandler(store *fileauth.Store, auth *serviceauth.Service, client *http.Client, endpoint string) *VoiceTranscriptionHandler {
	if client == nil {
		client = &http.Client{Timeout: 90 * time.Second}
	}
	if endpoint == "" {
		endpoint = "https://api.openai.com/v1/audio/transcriptions"
	}
	return &VoiceTranscriptionHandler{store: store, auth: auth, client: client, endpoint: endpoint}
}

func (h *VoiceTranscriptionHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/voice/transcription", h.transcribe)
	mux.HandleFunc("/api/admin/voice/api-key", h.settings)
}

func (h *VoiceTranscriptionHandler) settings(w http.ResponseWriter, r *http.Request) {
	if h.auth == nil {
		httptransport.SendErr(w, http.StatusServiceUnavailable, "Authentication is unavailable")
		return
	}
	email, err := callerEmailFromRequest(r, h.auth)
	if err != nil || email == "" {
		httptransport.SendErr(w, http.StatusUnauthorized, "authentication required")
		return
	}
	if admin, _ := h.auth.IsAdmin(r.Context(), email); !admin {
		httptransport.SendErr(w, http.StatusForbidden, "admin only")
		return
	}
	switch r.Method {
	case http.MethodGet:
	case http.MethodPut:
		var body struct {
			APIKey string `json:"apiKey"`
		}
		if err := readJSONBody(r, &body); err != nil || strings.TrimSpace(body.APIKey) == "" || len(body.APIKey) > 4096 {
			httptransport.SendErr(w, http.StatusBadRequest, "A valid API key is required")
			return
		}
		if err := h.store.SaveVoiceAPIKey(r.Context(), body.APIKey); err != nil {
			httptransport.SendErr(w, http.StatusInternalServerError, "Could not save API key")
			return
		}
	case http.MethodDelete:
		if err := h.store.DeleteVoiceAPIKey(r.Context()); err != nil {
			httptransport.SendErr(w, http.StatusInternalServerError, "Could not remove API key")
			return
		}
	default:
		httptransport.SendErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	key, err := h.store.VoiceAPIKey(r.Context())
	if err != nil {
		httptransport.SendErr(w, http.StatusInternalServerError, "Could not read API key status")
		return
	}
	httptransport.SendJSON(w, http.StatusOK, map[string]bool{"configured": key != ""})
}

func (h *VoiceTranscriptionHandler) transcribe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httptransport.SendErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	key, err := h.store.VoiceAPIKey(r.Context())
	if err != nil {
		httptransport.SendErr(w, http.StatusInternalServerError, "Could not read voice settings")
		return
	}
	if key == "" {
		httptransport.SendErr(w, http.StatusServiceUnavailable, "Add an OpenAI API key in Settings to use voice transcription")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxVoiceBytes+1024)
	if err := r.ParseMultipartForm(maxVoiceBytes + 1024); err != nil {
		httptransport.SendErr(w, http.StatusRequestEntityTooLarge, "Audio must be smaller than 25 MB")
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		httptransport.SendErr(w, http.StatusBadRequest, "Audio file is required")
		return
	}
	defer file.Close()
	if header.Size <= 0 || header.Size > maxVoiceBytes {
		httptransport.SendErr(w, http.StatusRequestEntityTooLarge, "Audio must be between 1 byte and 25 MB")
		return
	}
	extension := strings.ToLower(filepath.Ext(header.Filename))
	contentType := map[string]string{".webm": "audio/webm", ".mp4": "audio/mp4", ".ogg": "audio/ogg"}[extension]
	if contentType == "" {
		httptransport.SendErr(w, http.StatusBadRequest, "Unsupported audio format")
		return
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreatePart(textproto.MIMEHeader{
		"Content-Disposition": {`form-data; name="file"; filename="recording` + extension + `"`},
		"Content-Type":        {contentType},
	})
	if err == nil {
		_, err = io.Copy(part, file)
	}
	if err == nil {
		err = writer.WriteField("model", "gpt-transcribe")
	}
	if err == nil {
		err = writer.Close()
	}
	if err != nil {
		httptransport.SendErr(w, http.StatusInternalServerError, "Could not prepare audio")
		return
	}
	request, err := http.NewRequestWithContext(r.Context(), http.MethodPost, h.endpoint, &body)
	if err != nil {
		httptransport.SendErr(w, http.StatusInternalServerError, "Could not prepare transcription request")
		return
	}
	request.Header.Set("Authorization", "Bearer "+key)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := h.client.Do(request)
	if err != nil {
		httptransport.SendErr(w, http.StatusBadGateway, "Transcription service is unavailable")
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		httptransport.SendErr(w, http.StatusBadGateway, "Transcription failed; check the OpenAI API key and billing")
		return
	}
	var result struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&result); err != nil || strings.TrimSpace(result.Text) == "" {
		httptransport.SendErr(w, http.StatusBadGateway, "Transcription returned no text")
		return
	}
	httptransport.SendJSON(w, http.StatusOK, map[string]string{"text": result.Text})
}
