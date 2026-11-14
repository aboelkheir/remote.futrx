package httphandlers

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/futrx-com/remote.futrx.com/internal/stores/fileauth"
)

func TestVoiceTranscriptionForwardsAudioWithSavedKey(t *testing.T) {
	store := fileauth.New(t.TempDir())
	if err := store.SaveVoiceAPIKey(t.Context(), "server-secret"); err != nil {
		t.Fatal(err)
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer server-secret" {
			t.Errorf("Authorization header = %q", r.Header.Get("Authorization"))
		}
		if r.FormValue("model") != "gpt-transcribe" {
			t.Errorf("model = %q", r.FormValue("model"))
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			t.Errorf("file: %v", err)
			return
		}
		defer file.Close()
		data, _ := io.ReadAll(file)
		if header.Filename != "recording.webm" || string(data) != "sample audio" {
			t.Errorf("file = %q %q", header.Filename, data)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"text":"hello world"}`)
	}))
	defer upstream.Close()

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	file, _ := writer.CreateFormFile("file", "recording.webm")
	_, _ = io.WriteString(file, "sample audio")
	_ = writer.Close()
	r := httptest.NewRequest(http.MethodPost, "/api/voice/transcription", &body)
	r.Header.Set("Content-Type", writer.FormDataContentType())
	w := httptest.NewRecorder()
	NewVoiceTranscriptionHandler(store, nil, upstream.Client(), upstream.URL).transcribe(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body = %s", w.Code, w.Body.String())
	}
	var result map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || result["text"] != "hello world" {
		t.Fatalf("result = %v, err = %v", result, err)
	}
}

func TestVoiceTranscriptionRequiresSavedKey(t *testing.T) {
	w := httptest.NewRecorder()
	NewVoiceTranscriptionHandler(fileauth.New(t.TempDir()), nil, nil, "").transcribe(w, httptest.NewRequest(http.MethodPost, "/api/voice/transcription", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d; body = %s", w.Code, w.Body.String())
	}
}
