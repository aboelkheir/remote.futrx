// remote-mcp connects Telegram agents to Remote without a browser session.
// It speaks MCP over stdio; `watch` resumes durable Telegram notifications.
package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

type client struct {
	base, token, bot, owner, jobs string
	http                          *http.Client
}

type job struct {
	ID, ChatID, Title string
	Seq               int64
	LastUpdate        int64
	Answer            string
	Done              bool
}

type event struct {
	Seq     int64  `json:"seq"`
	Type    string `json:"type"`
	Text    string `json:"text"`
	Name    string `json:"name"`
	Message string `json:"message"`
}

type eventPage struct {
	Events  []event `json:"events"`
	LastSeq int64   `json:"lastSeq"`
}

func main() {
	c := client{
		base:  strings.TrimRight(os.Getenv("REMOTE_CONTROL_URL"), "/"),
		token: os.Getenv("REMOTE_CONTROL_TOKEN"),
		bot:   os.Getenv("REMOTE_TELEGRAM_BOT_TOKEN"),
		owner: os.Getenv("REMOTE_TELEGRAM_CHAT_ID"),
		jobs:  os.Getenv("REMOTE_CONTROL_JOBS_DIR"),
		http:  &http.Client{Timeout: 30 * time.Second},
	}
	if c.jobs == "" {
		c.jobs = "/var/lib/remote-control/jobs"
	}
	if c.base == "" || c.token == "" {
		fmt.Fprintln(os.Stderr, "remote control URL and token are required")
		os.Exit(2)
	}
	if len(os.Args) > 1 && os.Args[1] == "watch" {
		c.watch()
		return
	}
	c.serve()
}

func (c client) request(method, path string, body any) (json.RawMessage, error) {
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.base+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("Remote %d: %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
	return data, nil
}

func (c client) events(id string) (eventPage, error) {
	var page eventPage
	data, err := c.request("GET", "/api/chats/"+url.PathEscape(id)+"/events?limit=200", nil)
	if err == nil {
		err = json.Unmarshal(data, &page)
	}
	return page, err
}

func (c client) prompt(id, prompt string) (int64, error) {
	page, err := c.events(id)
	if err != nil {
		return 0, err
	}
	u, err := url.Parse(c.base)
	if err != nil {
		return 0, err
	}
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	u.Path = "/ws/chat/" + url.PathEscape(id)
	u.RawQuery = fmt.Sprintf("since=%d", page.LastSeq)
	conn, resp, err := websocket.DefaultDialer.Dial(u.String(), http.Header{"Authorization": []string{"Bearer " + c.token}})
	if err != nil {
		if resp != nil {
			return 0, fmt.Errorf("Remote websocket %d: %w", resp.StatusCode, err)
		}
		return 0, err
	}
	defer conn.Close()
	idBytes := make([]byte, 12)
	if _, err := rand.Read(idBytes); err != nil {
		return 0, err
	}
	clientID := hex.EncodeToString(idBytes)
	if err := conn.WriteJSON(map[string]string{"type": "prompt", "text": prompt, "clientId": clientID}); err != nil {
		return 0, err
	}
	_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	for {
		var ack struct {
			Type    string `json:"type"`
			Subtype string `json:"subtype"`
			Data    struct {
				ClientID string `json:"clientId"`
			} `json:"data"`
		}
		if err := conn.ReadJSON(&ack); err != nil {
			return 0, err
		}
		if ack.Type == "system" && ack.Data.ClientID == clientID {
			if ack.Subtype == "prompt_accepted" {
				return page.LastSeq, nil
			}
			return 0, errors.New("Remote rejected the prompt (chat may already be running)")
		}
	}
}

func (c client) sendSocket(id string, message any) error {
	u, err := url.Parse(c.base)
	if err != nil {
		return err
	}
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	u.Path = "/ws/chat/" + url.PathEscape(id)
	conn, resp, err := websocket.DefaultDialer.Dial(u.String(), http.Header{"Authorization": []string{"Bearer " + c.token}})
	if err != nil {
		if resp != nil {
			return fmt.Errorf("Remote websocket %d: %w", resp.StatusCode, err)
		}
		return err
	}
	defer conn.Close()
	return conn.WriteJSON(message)
}

func (c client) saveJob(j job) error {
	if err := os.MkdirAll(c.jobs, 0700); err != nil {
		return err
	}
	b, err := json.Marshal(j)
	if err != nil {
		return err
	}
	tmp := filepath.Join(c.jobs, j.ID+".tmp")
	if err := os.WriteFile(tmp, b, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(c.jobs, j.ID+".json"))
}

func (c client) sendTelegram(message string) error {
	if c.bot == "" || c.owner == "" {
		return errors.New("Telegram notification credentials are missing")
	}
	form := url.Values{"chat_id": {c.owner}, "text": {message}}
	resp, err := c.http.PostForm("https://api.telegram.org/bot"+c.bot+"/sendMessage", form)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("Telegram returned %d", resp.StatusCode)
	}
	return nil
}

func (c client) watch() {
	for {
		files, err := filepath.Glob(filepath.Join(c.jobs, "*.json"))
		if err == nil {
			for _, file := range files {
				c.advance(file)
			}
		}
		time.Sleep(8 * time.Second)
	}
}

func (c client) advance(file string) {
	b, err := os.ReadFile(file)
	if err != nil {
		return
	}
	var j job
	if json.Unmarshal(b, &j) != nil || j.Done {
		return
	}
	page, err := c.events(j.ChatID)
	if err != nil {
		return
	}
	for _, ev := range page.Events {
		if ev.Seq <= j.Seq {
			continue
		}
		switch ev.Type {
		case "assistant_text":
			j.Answer += ev.Text
			if len(j.Answer) > 6000 {
				j.Answer = j.Answer[len(j.Answer)-6000:]
			}
		case "tool_use_start":
			if time.Now().Unix()-j.LastUpdate > 90 {
				if c.sendTelegram("⏳ Remote: "+j.Title+" — بيشغّل "+ev.Name) == nil {
					j.LastUpdate = time.Now().Unix()
				}
			}
		case "interaction_request":
			if c.sendTelegram("⚠️ Remote محتاج موافقة أو رد في "+j.Title+". راجع الشات على Remote أو ابعت تعليمات للبوت.") == nil {
				j.LastUpdate = time.Now().Unix()
			}
		case "complete", "error":
			message := "✅ Remote خلص: " + j.Title
			if ev.Type == "error" {
				message = "❌ Remote توقف: " + j.Title + "\n" + ev.Message
			}
			if ev.Type == "complete" && strings.TrimSpace(j.Answer) != "" {
				message += "\n\n" + strings.TrimSpace(j.Answer)
			}
			if len([]rune(message)) > 3900 {
				message = string([]rune(message)[:3900])
			}
			if c.sendTelegram(message) == nil {
				j.Done = true
			} else {
				_ = c.saveJob(j)
				return
			}
		}
		j.Seq = ev.Seq
		if j.Done {
			break
		}
	}
	if j.Seq > 0 {
		_ = c.saveJob(j)
	}
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}
type tool struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	InputSchema any    `json:"inputSchema"`
}

func toolsList() []tool {
	object := func(required []string, fields map[string]string) any {
		if required == nil {
			required = []string{}
		}
		props := map[string]any{}
		for k, v := range fields {
			props[k] = map[string]string{"type": "string", "description": v}
		}
		return map[string]any{"type": "object", "properties": props, "required": required}
	}
	return []tool{
		{"remote_list_projects", "List Remote projects and their IDs/status", object(nil, nil)},
		{"remote_list_chats", "List Remote chats with project, agent, and running state", object(nil, nil)},
		{"remote_get_project", "Inspect a Remote project", object([]string{"projectId"}, map[string]string{"projectId": "Project ID"})},
		{"remote_get_chat", "Inspect a Remote chat", object([]string{"chatId"}, map[string]string{"chatId": "Chat ID"})},
		{"remote_project_action", "Start, stop, or restart a Remote project", object([]string{"projectId", "action"}, map[string]string{"projectId": "Project ID", "action": "start, stop, or restart"})},
		{"remote_create_chat", "Open a new chat in a project with a selected agent", object([]string{"projectId"}, map[string]string{"projectId": "Project ID", "title": "Chat title", "provider": "Agent provider, e.g. codex or claude", "model": "Optional model", "mode": "Optional mode"})},
		{"remote_update_chat", "Change chat title, agent, model, mode, reasoning, approval, or sandbox setting", object([]string{"chatId"}, map[string]string{"chatId": "Chat ID", "title": "New title", "provider": "New agent provider", "model": "New model", "mode": "New mode", "reasoningEffort": "New reasoning effort", "approvalPolicy": "New approval policy", "sandboxPolicy": "New sandbox policy"})},
		{"remote_get_settings", "Read Remote user settings", object(nil, nil)},
		{"remote_update_settings", "Change Remote user settings using a JSON object", object([]string{"settingsJson"}, map[string]string{"settingsJson": "JSON object of settings fields"})},
		{"remote_agent_capabilities", "List agents/models/modes available to a project", object([]string{"projectId"}, map[string]string{"projectId": "Project ID"})},
		{"remote_start_task", "Send a task to a Remote chat. Creates a chat if projectId is supplied without chatId. A durable watcher sends progress and completion to the owner's Telegram bot.", object([]string{"prompt"}, map[string]string{"prompt": "Instructions to run", "chatId": "Existing chat ID", "projectId": "Project ID for a new chat", "title": "New chat title", "provider": "Agent provider for a new chat"})},
		{"remote_get_events", "Read recent events and run status for a Remote chat", object([]string{"chatId"}, map[string]string{"chatId": "Chat ID"})},
		{"remote_cancel_task", "Cancel the currently running task in a Remote chat", object([]string{"chatId"}, map[string]string{"chatId": "Chat ID"})},
		{"remote_respond_interaction", "Answer a pending Remote agent interaction or approval. Read recent events first to get interactionId and requested shape.", object([]string{"chatId", "interactionId", "resultJson"}, map[string]string{"chatId": "Chat ID", "interactionId": "Pending interaction ID", "resultJson": "JSON result for the interaction"})},
	}
}

func (c client) invoke(name string, a map[string]string) (json.RawMessage, error) {
	id := a["chatId"]
	project := a["projectId"]
	switch name {
	case "remote_list_projects":
		return c.request("GET", "/api/projects", nil)
	case "remote_list_chats":
		return c.request("GET", "/api/chats", nil)
	case "remote_get_project":
		return c.request("GET", "/api/projects/"+url.PathEscape(project), nil)
	case "remote_get_chat":
		return c.request("GET", "/api/chats/"+url.PathEscape(id), nil)
	case "remote_project_action":
		if a["action"] != "start" && a["action"] != "stop" && a["action"] != "restart" {
			return nil, errors.New("action must be start, stop, or restart")
		}
		return c.request("POST", "/api/projects/"+url.PathEscape(project)+"/"+a["action"], nil)
	case "remote_create_chat":
		return c.request("POST", "/api/chats", map[string]string{"projectId": project, "title": a["title"], "provider": a["provider"], "model": a["model"], "mode": a["mode"]})
	case "remote_update_chat":
		body := map[string]string{}
		for _, k := range []string{"title", "provider", "model", "mode", "reasoningEffort", "approvalPolicy", "sandboxPolicy"} {
			if v, ok := a[k]; ok {
				body[k] = v
			}
		}
		return c.request("PATCH", "/api/chats/"+url.PathEscape(id), body)
	case "remote_get_settings":
		return c.request("GET", "/api/me/settings", nil)
	case "remote_update_settings":
		var body map[string]any
		if err := json.Unmarshal([]byte(a["settingsJson"]), &body); err != nil {
			return nil, err
		}
		return c.request("PATCH", "/api/me/settings", body)
	case "remote_agent_capabilities":
		return c.request("GET", "/api/agent-capabilities?projectId="+url.QueryEscape(project), nil)
	case "remote_get_events":
		return c.request("GET", "/api/chats/"+url.PathEscape(id)+"/events?limit=200", nil)
	case "remote_cancel_task":
		if err := c.sendSocket(id, map[string]string{"type": "cancel"}); err != nil {
			return nil, err
		}
		return json.Marshal(map[string]bool{"sent": true})
	case "remote_respond_interaction":
		var result json.RawMessage
		if err := json.Unmarshal([]byte(a["resultJson"]), &result); err != nil {
			return nil, err
		}
		if err := c.sendSocket(id, map[string]any{"type": "interaction_response", "interactionId": a["interactionId"], "result": result}); err != nil {
			return nil, err
		}
		return json.Marshal(map[string]bool{"sent": true})
	case "remote_start_task":
		if strings.TrimSpace(a["prompt"]) == "" {
			return nil, errors.New("prompt is required")
		}
		if id == "" {
			if project == "" {
				return nil, errors.New("chatId or projectId is required")
			}
			b, err := c.invoke("remote_create_chat", a)
			if err != nil {
				return nil, err
			}
			var meta struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(b, &meta); err != nil {
				return nil, err
			}
			id = meta.ID
		}
		seq, err := c.prompt(id, a["prompt"])
		if err != nil {
			return nil, err
		}
		jIDBytes := make([]byte, 12)
		if _, err = rand.Read(jIDBytes); err != nil {
			return nil, err
		}
		j := job{ID: hex.EncodeToString(jIDBytes), ChatID: id, Title: a["title"], Seq: seq}
		if j.Title == "" {
			j.Title = id
		}
		if err := c.saveJob(j); err != nil {
			return nil, err
		}
		return json.Marshal(map[string]any{"jobId": j.ID, "chatId": id, "status": "running", "telegramUpdates": c.bot != "" && c.owner != ""})
	}
	return nil, fmt.Errorf("unknown tool %q", name)
}

func (c client) serve() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 4<<20)
	out := bufio.NewWriter(os.Stdout)
	for scanner.Scan() {
		var req rpcRequest
		if json.Unmarshal(scanner.Bytes(), &req) != nil || len(req.ID) == 0 {
			continue
		}
		var result any
		var err error
		switch req.Method {
		case "initialize":
			result = map[string]any{"protocolVersion": "2025-03-26", "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]string{"name": "remote-control", "version": "1.0.0"}}
		case "ping":
			result = map[string]any{}
		case "tools/list":
			result = map[string]any{"tools": toolsList()}
		case "tools/call":
			var p struct {
				Name      string            `json:"name"`
				Arguments map[string]string `json:"arguments"`
			}
			if err = json.Unmarshal(req.Params, &p); err == nil {
				var data json.RawMessage
				data, err = c.invoke(p.Name, p.Arguments)
				if err == nil {
					result = map[string]any{"content": []any{map[string]string{"type": "text", "text": string(data)}}}
				}
			}
			if err != nil {
				result = map[string]any{"content": []any{map[string]string{"type": "text", "text": err.Error()}}, "isError": true}
				err = nil
			}
		default:
			err = fmt.Errorf("method not found")
		}
		response := map[string]any{"jsonrpc": "2.0", "id": req.ID}
		if err != nil {
			response["error"] = map[string]any{"code": -32601, "message": err.Error()}
		} else {
			response["result"] = result
		}
		b, _ := json.Marshal(response)
		_, _ = out.Write(append(b, '\n'))
		_ = out.Flush()
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
}
