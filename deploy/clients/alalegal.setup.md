# ALA Legal Subdomain Setup (`alalegal.proyectoprisma.com`)

## 1) DNS

Create this record in your DNS provider:

- Type: `A`
- Host: `alalegal`
- Value: `<YOUR_SERVER_PUBLIC_IP>`

Verify propagation:

```bash
getent ahosts alalegal.proyectoprisma.com
```

## 2) Env file

```bash
cp deploy/clients/alalegal.env.template deploy/clients/alalegal.env
nano deploy/clients/alalegal.env
```

Fill all `CHANGE_ME_*` values.

## 3) Launch containers

```bash
docker compose -p alalegal --env-file deploy/clients/alalegal.env up -d --build
docker compose -p alalegal --env-file deploy/clients/alalegal.env ps
```

## 4) Caddy

Append this block to your existing `/etc/caddy/Caddyfile` (do not overwrite other hosts):

```bash
# If repo path is /opt/ala-legal:
sudo bash -c 'cat /opt/ala-legal/deploy/caddy/alalegal.proyectoprisma.com.Caddyfile >> /etc/caddy/Caddyfile'
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager
```

## 5) Telegram webhook

```bash
ENV_FILE="deploy/clients/alalegal.env"
BOT_TOKEN="$(awk -F= '/^TELEGRAM_BOT_TOKEN=/{print $2}' "$ENV_FILE")"
PATH_TOKEN="$(awk -F= '/^TELEGRAM_WEBHOOK_PATH_TOKEN=/{print $2}' "$ENV_FILE")"
SECRET_TOKEN="$(awk -F= '/^TELEGRAM_WEBHOOK_SECRET=/{print $2}' "$ENV_FILE")"

curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -d "url=https://alalegal.proyectoprisma.com/telegram/webhook/${PATH_TOKEN}" \
  -d "secret_token=${SECRET_TOKEN}" \
  -d 'allowed_updates=["message","edited_message"]'
```

## 6) ManyChat webhook

In ManyChat External Request use:

`https://alalegal.proyectoprisma.com/manychat/webhook`

## 7) Smoke test

```bash
curl -sS https://alalegal.proyectoprisma.com/health
ADMIN_SECRET="$(awk -F= '/^ADMIN_SECRET=/{print $2}' deploy/clients/alalegal.env)"
curl -sS https://alalegal.proyectoprisma.com/admin/pending -H "Authorization: ${ADMIN_SECRET}"
```
