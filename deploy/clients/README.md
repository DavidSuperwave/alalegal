# Client Subdomain Deployment Template

This folder contains templates for deploying one client per subdomain.

## Target pattern

- Landing site: `proyectoprisma.com`
- Client runtime: `<client>.proyectoprisma.com`
  - Example: `alalegal.proyectoprisma.com`

## 1) Create a client env file

Start from the provided template:

```bash
cp deploy/clients/alalegal.env.template deploy/clients/<client>.env
```

Set all required secrets in that file.

For faster replication, use the scaffold script:

```bash
bash deploy/clients/new-client.sh --client <slug> --domain <slug>.proyectoprisma.com --bridge-port <port> --web-port <port> --gateway-port <port>
```

See full runbook:

- `deploy/clients/CLIENT_ONBOARDING_PLAYBOOK.md`

## 2) Launch the client stack

```bash
docker compose -p <client> --env-file deploy/clients/<client>.env up -d --build
```

With this repository's compose config:

- Containers are namespaced by `CLIENT_SLUG`
- Host ports are configurable via:
  - `AGENT_GATEWAY_PORT`
  - `BRIDGE_PUBLIC_PORT`
  - `WEB_PUBLIC_PORT`

## 3) DNS

Create an `A` record:

- Host: `<client>.proyectoprisma.com`
- Value: your server public IP

## 4) Caddy reverse proxy

Use a client-specific Caddy block. Example file:

- `deploy/caddy/alalegal.proyectoprisma.com.Caddyfile`

## 5) Register Telegram webhook

After stack and DNS are live:

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

## 6) ManyChat webhook URL

Configure ManyChat External Request to:

`https://<client>.proyectoprisma.com/manychat/webhook`
