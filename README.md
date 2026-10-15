# QQ Bridge

Stays running on the box. Connects to the official QQ bot WebSocket gateway, receives C2C (private) messages and group @ messages, and forwards each one to the webhook of the agent "QQ 小企鹅". Replies come back through a local HTTP endpoint, and the bridge sends them out as passive replies.

## Environment variables
| Variable | Required | Description |
|---|---|---|
| QQ_APP_ID | yes | QQ bot AppID (env only, never written to disk or logs) |
| QQ_APP_SECRET | yes | QQ bot AppSecret (env only) |
| QQ_FORWARD_WEBHOOK_URL | no | Forward URL. Overrides `forwardWebhookUrl` in config.json |
| QQ_FORWARD_WEBHOOK_SECRET | no | Webhook secret, sent as a request header |
| QQ_FORWARD_WEBHOOK_HEADER | no | Header name, default `Authorization: Bearer <secret>` |
| QQ_REPLY_PORT | no | Reply port, default 8787 |
| QQ_API_BASE / QQ_TOKEN_URL | no | Testing only: overrides the QQ API endpoints |

If QQ_APP_ID or QQ_APP_SECRET is missing, the bridge exits with code 78 and the supervisor stops too.

## Start / stop
```
export QQ_APP_ID=... QQ_APP_SECRET=... QQ_FORWARD_WEBHOOK_URL=... QQ_FORWARD_WEBHOOK_SECRET=...
./start.sh   # starts the run_loop.sh supervisor in the background; it restarts the bridge after a crash (backoff 2s up to 60s)
./stop.sh
```
Logs: `logs/bridge.log`, `logs/supervisor.log`. The box has no systemd, so a bash loop does the supervising.

## Inbound forwarding (bridge -> QQ 小企鹅)
`POST $QQ_FORWARD_WEBHOOK_URL`, Content-Type: application/json, with header `Authorization: Bearer <secret>: <secret>`. A failed POST is retried up to 3 times.
```json
{"type":"c2c","openid":"USER_OPENID","author":{"user_openid":"USER_OPENID"},
 "content":"你好","msg_id":"ROBOT1.0_xxx","timestamp":"2026-10-14T11:00:00+08:00","attachments":[]}
{"type":"group","group_openid":"GROUP_OPENID","author":{"member_openid":"MEMBER_OPENID"},
 "content":"你好","msg_id":"ROBOT1.0_yyy","timestamp":"...","attachments":[]}
```

## Reply API (QQ 小企鹅 -> bridge)
`POST http://127.0.0.1:8787/reply`, header `X-Reply-Token: <contents of reply_token>` (a local token the bridge generates automatically; it is not a QQ credential).
```json
{"type":"c2c","openid":"USER_OPENID","msg_id":"ROBOT1.0_xxx","content":"回复内容"}
{"type":"group","group_openid":"GROUP_OPENID","msg_id":"ROBOT1.0_yyy","content":"回复内容"}
```
- With `msg_id`, the message goes out as a passive reply, and the bridge increments `msg_seq` for each msg_id on its own. Without `msg_id` it is an active message, which QQ heavily restricts.
- Passive replies have time limits (QQ docs: about 60 minutes for private chat, about 5 minutes for groups) and a cap on replies per message.
- Response codes: 200 `{"ok":true,"result":...}`; 400 bad parameters; 401 bad token; 502 QQ API error (body includes detail).
- `GET /health` is a health check.
- CLI: `./reply.sh c2c <openid> <msg_id|-> 回复内容`

## Implementation notes
- Token: `POST https://bots.qq.com/app/getAppAccessToken {appId, clientSecret}`. Refreshed 60 seconds before it expires.
- Gateway: `GET /gateway` → WS. On Hello (op10) the bridge starts heartbeats (op1); it sends Identify (op2) with intents `1<<25` (GROUP_AND_C2C_EVENT), or Resume (op6) when it already has a session. op7 → reconnect; op9 → re-identify; a missed heartbeat ACK → reconnect; reconnects use exponential backoff up to 60s.
- Tests: `node test/test.js` (payload conversion, plus the reply server against a mock QQ API).
