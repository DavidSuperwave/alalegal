# DEPLOY — Guía de Despliegue en Digital Ocean

> Tiempo estimado: 20–30 minutos en un servidor limpio.
> La base de datos se migra automáticamente al iniciar — no hay pasos de SQL manuales.

---

## Requisitos previos

- Cuenta en [Digital Ocean](https://cloud.digitalocean.com)
- Dominio apuntando al servidor (p. ej. `bot.superwave.ai`)
- Credenciales listas: OpenRouter API key, ManyChat API key

---

## Paso 1 — Crear el Droplet en Digital Ocean

1. Entra a [cloud.digitalocean.com](https://cloud.digitalocean.com) → **Create** → **Droplets**.
2. Elige la imagen: **Ubuntu 24.04 LTS x64**.
3. Elige el plan: **Basic — 2 vCPU / 4 GB RAM / 80 GB SSD** (~$24/mes).
   - Si el tráfico es bajo, el plan de 1 vCPU / 2 GB RAM (~$12/mes) es suficiente para empezar.
4. Datacenter: **NYC1** o **TOR1** (más cercano a México que EU).
5. Autenticación: **SSH key** (recomendado). Pega tu clave pública.
6. Nombre del droplet: `ala-legal-bot` o similar.
7. Haz clic en **Create Droplet**.

---

## Paso 2 — Conectarse e instalar Docker

```bash
# Conéctate vía SSH (reemplaza con la IP de tu droplet)
ssh root@<IP_DEL_DROPLET>

# Actualizar el sistema
apt update && apt upgrade -y

# Instalar Docker Engine + Docker Compose v2
apt install -y ca-certificates curl gnupg

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | tee /etc/apt/sources.list.d/docker.list > /dev/null

apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Verificar instalación
docker --version
docker compose version
```

---

## Paso 3 — Clonar el repositorio

```bash
apt install -y git

git clone https://github.com/DavidSuperwave/superwave-agent.git /opt/ala-legal
cd /opt/ala-legal
```

---

## Paso 4 — Configurar variables de entorno

```bash
cp .env.example .env
nano .env
```

Llena los siguientes valores:

| Variable | Descripción | Cómo obtenerla |
|---|---|---|
| `POSTGRES_PASSWORD` | Contraseña de la BD local | `openssl rand -hex 32` |
| `OPENROUTER_API_KEY` | Clave del LLM | [openrouter.ai](https://openrouter.ai) → Keys |
| `MANYCHAT_API_KEY` | Token de ManyChat | ManyChat → Settings → API → Access Token |
| `ADMIN_SECRET` | Protege `/admin/stats` | `openssl rand -hex 24` |
| `SUPERWAVE_WEBHOOK_SECRET` | Autenticación bridge→agente (requerida) | `openssl rand -hex 32` |
| `TELEGRAM_BOT_TOKEN` | Bot para revisión humana | @BotFather |
| `TELEGRAM_REVIEW_CHAT_ID` | Chat/grupo de revisión | ID numérico del chat |
| `TELEGRAM_WEBHOOK_PATH_TOKEN` | Token de ruta webhook Telegram | `openssl rand -hex 16` |
| `TELEGRAM_WEBHOOK_SECRET` | Secret header de Telegram webhook | `openssl rand -hex 24` |
| `KANBAN_API_BASE_URL` | URL base del dashboard workspace API | Normalmente `http://web:3100` |
| `KANBAN_OBJECT_NAME` | Objeto kanban destino | `task` (default) o tu objeto (ej. `leads`) |
| `KANBAN_STAGE_NEW` | Estado inicial del lead | Default `In Queue` |
| `KANBAN_STAGE_QUALIFIED` | Estado para lead calificado | Default `In Progress` |
| `KANBAN_STAGE_ARCHIVE` | Estado para lead de bajo fit | Default `Done` |
| `FIT_SCORE_HIGH` | Umbral alto de fit | Default `0.75` |
| `FIT_SCORE_LOW` | Umbral bajo de fit | Default `0.35` |

Guarda el archivo (`Ctrl+O`, `Enter`, `Ctrl+X` en nano).

---

## Paso 5 — Levantar todos los servicios

```bash
cd /opt/ala-legal

# Construir imágenes y levantar en segundo plano
docker compose up -d --build

# El bridge crea las tablas en la BD automáticamente al arrancar
# Verificar que todos los servicios estén corriendo
docker compose ps

# Ver logs del bridge (deberías ver "[pg] Tables verified / created")
docker compose logs -f bridge

# Verificar health del bridge
curl http://localhost:4000/health
```

Salida esperada del health check:
```json
{
  "status": "ok",
  "uptime": 12,
  "lastMessage": null,
  "stats": {},
  "db": "connected"
}
```

---

## Paso 6 — Configurar ManyChat (campos y etiquetas)

```bash
cd /opt/ala-legal
export $(grep -v '^#' .env | xargs)
chmod +x setup-manychat.sh
./setup-manychat.sh
```

Deberías ver `✓ Custom field: ...` y `✓ Tag: ...` para cada campo/etiqueta.

---

## Paso 7 — Configurar ManyChat External Request

Ver el archivo `MANYCHAT-FLOW.md` para instrucciones detalladas.

URL del webhook:
```
https://bot.superwave.ai/manychat/webhook
```

---

## Paso 8 — Configurar webhook de Telegram (revisión humana)

```bash
source .env

curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=https://bot.superwave.ai/telegram/webhook/${TELEGRAM_WEBHOOK_PATH_TOKEN}" \
  -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  -d 'allowed_updates=["message","edited_message"]'
```

Comandos disponibles en Telegram:

- `/pending`
- `/approve <review_id>`
- `/reply <review_id> <texto>`
- `/help`

Modo asistente:

- Mensajes sin `/` se envían al agente para soporte operativo del equipo en ese mismo chat.

---

## Paso 9 — Dominio + SSL con Caddy

Caddy gestiona SSL automático vía Let's Encrypt.

```bash
# Instalar Caddy
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudflare.com/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudflare.com/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install caddy

# Crear Caddyfile
cat > /etc/caddy/Caddyfile << 'EOF'
bot.superwave.ai {
  handle /manychat/* {
    reverse_proxy localhost:4000
  }
  handle /telegram/* {
    reverse_proxy localhost:4000
  }
  handle /admin/* {
    reverse_proxy localhost:4000
  }
  handle /health {
    reverse_proxy localhost:4000
  }
  handle {
    reverse_proxy localhost:3100
  }
}
EOF

systemctl reload caddy
systemctl status caddy
```

> Asegúrate de que el DNS de `bot.superwave.ai` apunte a la IP del droplet **antes** de ejecutar Caddy.

---

## Paso 10 — Prueba funcional

Envía un mensaje de WhatsApp o Messenger a tu página conectada en ManyChat:

```
Hola, tuve un accidente y la aseguradora no me quiere pagar
```

Flujo esperado:

1. El cliente recibe ACK inmediato.
2. En Telegram llega lead con `review_id`.
3. Apruebas con `/approve <review_id>` o editas con `/reply <review_id> <texto>`.
4. El cliente recibe el mensaje final enviado por ManyChat API.

Verifica los registros en la BD local:

```bash
docker compose exec db psql -U superwave -d superwave -c "SELECT * FROM mc_messages LIMIT 5;"
docker compose exec db psql -U superwave -d superwave -c "SELECT review_id,status FROM mc_pending_reviews ORDER BY created_at DESC LIMIT 5;"
```

---

## Mantenimiento

### Ver logs
```bash
docker compose logs -f bridge
docker compose logs --tail=100 agent
```

### Actualizar el código
```bash
cd /opt/ala-legal
git pull
docker compose up -d --build bridge
```

### Reiniciar un servicio
```bash
docker compose restart bridge
```

### Backup de base de datos
```bash
docker compose exec db pg_dump -U superwave superwave > backup_$(date +%Y%m%d).sql
```

### Ver stats del bridge
```bash
curl -H "Authorization: TU_ADMIN_SECRET" https://bot.superwave.ai/admin/stats | jq
```

---

## Firewall recomendado (UFW)

```bash
ufw allow 22/tcp   # SSH
ufw allow 80/tcp   # HTTP (Caddy redirect)
ufw allow 443/tcp  # HTTPS
ufw --force enable
ufw status
```

Los puertos 4000, 3000, 8080, 3100 **no** deben ser accesibles públicamente — solo Caddy en 80/443.

---

## Resolución de problemas comunes

| Problema | Solución |
|---|---|
| `docker compose up` falla con error de permisos | `chmod 600 .env` y verifica que Docker esté corriendo: `systemctl start docker` |
| El bridge muestra `DB migration failed` | Verifica que `db` esté healthy: `docker compose ps`. El bridge funciona sin BD pero no guardará logs. |
| El bridge responde `Cannot connect to agent` | Espera 30 s a que el agente inicialice: `docker compose logs agent` |
| Caddy no obtiene certificado SSL | Verifica que el DNS ya apunte a tu IP: `dig bot.superwave.ai` |
| ManyChat no llega al webhook | Verifica que el External Request apunte a `https://bot.superwave.ai/manychat/webhook` con método POST |
| No llega revisión a Telegram | Revisa `TELEGRAM_BOT_TOKEN`, `TELEGRAM_REVIEW_CHAT_ID` y ejecuta `setWebhook` del Paso 8 |
| Aprobas en Telegram pero no sale mensaje al cliente | Verifica `MANYCHAT_API_KEY` y logs de bridge para errores de `/fb|wa/subscriber/sendContent` |
| No se crean leads en kanban | Valida que `web` esté arriba y que `KANBAN_OBJECT_NAME` exista (`task` recomendado al inicio) |
