# Client Onboarding Playbook (Template Replication)

This runbook defines the repeatable process for launching each new client instance
on `<client>.proyectoprisma.com` with the same core integrations:

- ManyChat inbound webhook
- Agent classification + suggested replies
- Kanban lead creation
- Telegram review + assist workflow

---

## 0) Client intake checklist (what you request from client)

### Required from client

1. **ManyChat API token** (Access Token)
2. **Telegram bot token** (or approval to create a new bot)
3. **Telegram review chat/group ID**
4. **Domain delegation/access** for DNS record:
   - `<client>.proyectoprisma.com` -> deployment server IP
5. **OpenRouter key** (or whichever model provider you use)

### Recommended from client

1. Brand voice guidelines / assistant tone
2. Legal disclaimer and fallback contact text
3. Preferred kanban statuses and priority mapping
4. Admin dashboard email

---

## 1) Create scaffolding

Use the helper script:

```bash
bash deploy/clients/new-client.sh \
  --client <slug> \
  --domain <slug>.proyectoprisma.com \
  --bridge-port <host-port> \
  --web-port <host-port> \
  --gateway-port <host-port>
```

For ALA Legal (example):

```bash
bash deploy/clients/new-client.sh \
  --client alalegal \
  --domain alalegal.proyectoprisma.com \
  --bridge-port 4011 \
  --web-port 3111 \
  --gateway-port 3011
```

---

## 2) Fill client env

Edit `deploy/clients/<client>.env` and set all `CHANGE_ME_*` values.

Minimum required keys:

- `POSTGRES_PASSWORD`
- `OPENROUTER_API_KEY`
- `SUPERWAVE_WEBHOOK_SECRET`
- `BRIDGE_SECRET`
- `ADMIN_SECRET`
- `MANYCHAT_API_KEY` (with `Bearer ...`)
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_REVIEW_CHAT_ID`
- `TELEGRAM_WEBHOOK_PATH_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `DASHBOARD_AUTH_SECRET`
- `DASHBOARD_ADMIN_PASSWORD`

---

## 3) DNS

Create:

- Type: `A`
- Host: `<client>`
- Value: `<server-public-ip>`

Verify:

```bash
dig +short <client>.proyectoprisma.com A
```

---

## 4) Deploy containers

```bash
docker compose -p <client> --env-file deploy/clients/<client>.env up -d --build
docker compose -p <client> --env-file deploy/clients/<client>.env ps
```

---

## 5) Configure Caddy

Append generated block:

```bash
sudo bash -c 'cat /opt/ala-legal/deploy/caddy/<client>.proyectoprisma.com.Caddyfile >> /etc/caddy/Caddyfile'
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager
```

---

## 6) Register Telegram webhook

```bash
ENV_FILE="deploy/clients/<client>.env"
BOT_TOKEN="$(awk -F= '/^TELEGRAM_BOT_TOKEN=/{print $2}' "$ENV_FILE")"
PATH_TOKEN="$(awk -F= '/^TELEGRAM_WEBHOOK_PATH_TOKEN=/{print $2}' "$ENV_FILE")"
SECRET_TOKEN="$(awk -F= '/^TELEGRAM_WEBHOOK_SECRET=/{print $2}' "$ENV_FILE")"

curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -d "url=https://<client>.proyectoprisma.com/telegram/webhook/${PATH_TOKEN}" \
  -d "secret_token=${SECRET_TOKEN}" \
  -d 'allowed_updates=["message","edited_message"]'
```

Compatibility alias (also accepted):

`https://<client>.proyectoprisma.com/api/telegram/webhook/<PATH_TOKEN>`

---

## 7) Configure ManyChat

In ManyChat External Request action:

- URL: `https://<client>.proyectoprisma.com/manychat/webhook`
- Method: `POST`
- `Content-Type: application/json`
- Body uses subscriber + last_input fields

Compatibility alias (also accepted):

- URL: `https://<client>.proyectoprisma.com/api/manychat/webhook`

Detailed flow mapping:

- `MANYCHAT-FLOW.md`

---

## 8) Smoke tests (must pass before go-live)

1. Bridge health:

```bash
curl -sS https://<client>.proyectoprisma.com/health
```

2. Telegram webhook status:

```bash
curl -sS "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
```

3. ManyChat intake dry message:

```bash
curl -X POST "https://<client>.proyectoprisma.com/manychat/webhook" \
  -H "Content-Type: application/json" \
  -d '{
    "subscriber_id":"test-123",
    "first_name":"Test",
    "last_name":"User",
    "last_input_text":"Quiero una cita",
    "channel":"instagram"
  }'
```

Expected:

- Returns `review_id`
- Review appears in Telegram
- `/pending` lists it
- `/approve <review_id>` sends final message path

---

## 9) Customization knobs per client

Keep core integration identical; customize only these:

### Messaging / brand
- `MANYCHAT_ACK_TEXT`
- `DASHBOARD_ADMIN_EMAIL`
- `DASHBOARD_ADMIN_NAME`
- SOUL/identity files mounted for agent persona

### Pipeline behavior
- `KANBAN_OBJECT_NAME`
- `KANBAN_DEFAULT_STATUS`
- `AGENT_ANALYSIS_TIMEOUT_MS`
- `TELEGRAM_AGENT_ASSIST_ENABLED`

### Security
- rotate all secrets per client:
  - `SUPERWAVE_WEBHOOK_SECRET`
  - `BRIDGE_SECRET`
  - `ADMIN_SECRET`
  - Telegram webhook path + secret

---

## 10) Ops maintenance

### Update one client stack

```bash
docker compose -p <client> --env-file deploy/clients/<client>.env up -d --build
```

### View logs

```bash
docker compose -p <client> --env-file deploy/clients/<client>.env logs -f bridge web agent
```

### DB table checks

```bash
docker compose -p <client> --env-file deploy/clients/<client>.env exec db \
  psql -U superwave -d superwave_<client> -c "\\dt mc_*"
```
