# Remote control from OpenClaw and Hermes

The `remote-mcp` binary gives both Telegram agents a small set of Remote
project, chat, agent, and user-setting tools. It uses a different bearer token
per agent, scoped by the backend to these routes only. It never uses a browser
cookie, shell, host credentials, or the Remote terminal. A watcher process per
agent reads durable job files and sends progress/completion through that
agent's existing Telegram bot.

## Build

From `backend/` on the ARM64 host, then copy into the agent LXD instance:

```sh
go build -trimpath -o /tmp/remote-mcp ./cmd/remote-mcp
lxc file push /tmp/remote-mcp agent-stack/opt/ai-agents/remote-control/remote-mcp
lxc exec agent-stack -- chmod 0755 /opt/ai-agents/remote-control/remote-mcp
```

The binary must be executable inside both agent containers at
`/opt/remote-control/remote-mcp`. Mount the same binary read-only, and mount a
separate writable job directory for each agent. Run the watcher as an LXD
systemd service using `remote-control-watcher@.service` (`openclaw` and
`hermes` instances). This resumes pending jobs after a container restart.

## Private configuration

Set `REMOTE_CONTROL_TOKENS_FILE` in Remote's private `config.env` to a root-only
JSON file. Example shape:

```json
{"clients":[
  {"name":"openclaw","tokenSha256":"<64 hex characters>","email":"<registered owner email>","sub":"<owner session sub, if used>"},
  {"name":"hermes","tokenSha256":"<64 hex characters>","email":"<registered owner email>","sub":"<owner session sub, if used>"}
]}
```

Generate two independent random 48-byte tokens and store only their SHA-256
digests in that file. Never commit raw tokens. Give each agent its own private
environment file, mounted through Docker Compose, with:

```text
REMOTE_CONTROL_URL=http://10.151.237.1:17682
REMOTE_CONTROL_TOKEN=<that agent's raw token>
REMOTE_CONTROL_JOBS_DIR=/opt/remote-control/jobs
REMOTE_TELEGRAM_BOT_TOKEN=<that agent's existing bot token>
REMOTE_TELEGRAM_CHAT_ID=<owner's Telegram numeric chat ID>
```

The host Caddy listener `http://10.151.237.1:17682` should reverse proxy to
`127.0.0.1:7682`. Allow only `10.151.237.2 -> 10.151.237.1:17682` in the
host firewall and only `172.29.10.0/24` and `172.29.20.0/24` outbound to
`10.151.237.1:17682` in the LXD Docker firewall. Keep the existing private
network and metadata denials. This port is not exposed to the public internet.

## Agent configuration

OpenClaw `openclaw.json`:

```json
"mcp": {"servers": {"remote": {
  "command": "/opt/remote-control/remote-mcp", "enabled": true,
  "env": {"REMOTE_CONTROL_URL": "<private bridge URL>", "REMOTE_CONTROL_TOKEN": "<OpenClaw token>",
          "REMOTE_CONTROL_JOBS_DIR": "/opt/remote-control/jobs", "REMOTE_TELEGRAM_BOT_TOKEN": "<OpenClaw bot token>",
          "REMOTE_TELEGRAM_CHAT_ID": "<owner Telegram ID>"}
}}}
```

Hermes `config.yaml`:

```yaml
mcp_servers:
  remote:
    command: /opt/remote-control/remote-mcp
    enabled: true
    timeout: 120
    env:
      REMOTE_CONTROL_URL: <private bridge URL>
      REMOTE_CONTROL_TOKEN: <Hermes token>
      REMOTE_CONTROL_JOBS_DIR: /opt/remote-control/jobs
      REMOTE_TELEGRAM_BOT_TOKEN: <Hermes bot token>
      REMOTE_TELEGRAM_CHAT_ID: <owner Telegram ID>
```

Both MCP runtimes launch child processes with a filtered environment, so the
same values must appear in each MCP server's private `env` mapping. Existing
Telegram owner allowlists must remain enabled. `remote_start_task` accepts an
existing `chatId`, or a `projectId` to create a chat. It returns a job and chat
ID immediately. The watcher sends tool progress (at most once per 90 seconds),
approval requests, and the final answer/error to the owner. The bot can also
call `remote_get_events`, `remote_respond_interaction`, and
`remote_cancel_task` in response to later Telegram messages.

## Verification

1. Probe `remote_list_projects` from each agent's MCP client. Confirm both
   identities work and invalid tokens return 401.
2. Confirm a control token cannot reach `/api/admin/users`, project secrets,
   `/ws/terminal`, or any DELETE route (403).
3. Start a harmless task in a test chat from each Telegram bot. Confirm
   acknowledgement, progress, final message, and watcher recovery after an
   agent container restart.

Because a job can finish before the first poll, the watcher reads the last
200 chat events by sequence. Very noisy chats producing more than 200 events
between polls may lose an intermediate update; the final status is still
reported when its event remains in that window.
