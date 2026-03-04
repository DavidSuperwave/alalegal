# MANYCHAT-FLOW — Configuración de Flujos en ManyChat

> Esta guía explica exactamente cómo configurar ManyChat para que cada mensaje del usuario sea procesado por el bridge de Superwave.

---

## Arquitectura del flujo (v3 — aprobación en Telegram)

```
Usuario (WhatsApp / Messenger / Instagram / TikTok)
    ↓  escribe un mensaje
ManyChat recibe el mensaje
    ↓  activa el "Default Reply"
Flow: Superwave — Lead Intake
    ↓  acción: External Request (HTTP POST)
Bridge en bot.superwave.ai:4000
    ↓  agente clasifica + sugiere respuesta
    ↓  bridge crea lead en tablero kanban
    ↓  bridge envía revisión al equipo por Telegram
Bridge devuelve ACK inmediato a ManyChat (opcional)
    ↓  humano aprueba/edita en Telegram
    ↓  bridge envía respuesta final por ManyChat API
```

---

## Parte 1 — Crear el flujo principal

### 1.1 Navegar a Flows

1. Entra a [manychat.com](https://manychat.com) y selecciona tu página.
2. En el menú lateral izquierdo, haz clic en **Flows**.
3. Haz clic en el botón azul **+ New Flow** (esquina superior derecha).
4. Nombra el flujo: `Superwave — Lead Intake`.
5. Haz clic en **Create**.

---

### 1.2 Agregar el trigger (Default Reply)

El flujo debe activarse cada vez que llega cualquier mensaje sin otro flujo específico.

1. En el editor del flujo, haz clic en **+ Add Trigger** (parte superior del canvas).
2. En la ventana que aparece, busca y selecciona: **Default Reply**.
3. Repite el paso 2 para cada canal:
   - **Default Reply — Facebook Messenger**
   - **Default Reply — Instagram DM**
   - **Default Reply — WhatsApp**
   - **Default Reply — TikTok** (si está disponible en tu cuenta)
4. Haz clic en **Done**.

> **Nota:** Si ya existe un Default Reply configurado en otro flujo, primero debes eliminarlo de ese flujo antes de asignarlo aquí.

---

### 1.3 Agregar la acción de External Request

1. En el canvas del flujo, haz clic en el bloque **Start** y luego en el signo **+** para agregar un paso.
2. Selecciona **Action**.
3. En la lista de acciones, busca y selecciona **External Request**.
4. Aparecerá el editor de External Request. Confíguralo así:

#### Configuración del External Request

**Method:** `POST`

**URL:**
```
https://bot.superwave.ai/manychat/webhook
```
*(Reemplaza `bot.superwave.ai` con tu dominio real)*

**Headers** (haz clic en "+ Add Header"):

| Key | Value |
|---|---|
| `Content-Type` | `application/json` |

*(No agregues Authorization aquí — la autenticación se maneja vía BRIDGE_SECRET si lo activas)*

**Body type:** `JSON`

**Body:** Haz clic en el área de body y pega el siguiente JSON. Para insertar variables dinámicas de ManyChat, usa el botón `{}` que aparece en el editor:

```json
{
  "subscriber_id": "{{subscriber:id}}",
  "first_name":    "{{subscriber:first_name}}",
  "last_name":     "{{subscriber:last_name}}",
  "last_input_text": "{{last_input:text}}",
  "channel":       "{{channel}}",
  "email":         "{{subscriber:email}}",
  "phone":         "{{subscriber:phone}}"
}
```

> **Cómo insertar variables:** en el editor de body, escribe el texto del JSON y, cuando llegues a un valor dinámico, haz clic en el botón **{}** → selecciona la categoría (Subscriber, Last Input, etc.) → selecciona el campo.

**Timeout:** `30` segundos (el límite máximo de ManyChat; el bridge responde en ~5–15s normalmente).

**On Success:** Selecciona "Save full response to a Custom Field" si quieres guardar la respuesta raw, o déjalo en blanco por ahora ya que usaremos el Response Mapping en el siguiente paso.

---

### 1.4 Mapear la respuesta

En v3 el bridge **ya no devuelve la respuesta final del agente** en ese momento.  
Ahora devuelve un **ACK rápido** mientras el equipo revisa por Telegram.

Respuesta típica:

```json
{
  "version": "v2",
  "content": {
    "messages": [
      { "type": "text", "text": "Gracias por tu mensaje..." }
    ]
  },
  "review_id": "rvw_ab12cd34ef56",
  "classification": "consulta_legal"
}
```

Configuración recomendada:

1. En la acción External Request, deja la respuesta dinámica activada solo para mostrar el ACK.
2. (Opcional) Guarda `$.review_id` en un custom field `review_id`.
3. (Opcional) Guarda `$.classification` en `ultima_clasificacion`.
4. **No dependas de `$.content.messages[0].text` como respuesta final**; la respuesta final se enviará después desde el bridge vía ManyChat API cuando apruebes en Telegram.

---

### 1.5 Mensaje de fallback

Agrega un paso de mensaje **después** del External Request para el caso de error:

1. Haz clic en **+** → **Message**.
2. Escribe el texto:
   ```
   Disculpe, en este momento no puedo procesar su mensaje. Por favor intente de nuevo en unos minutos.
   ```
3. Conecta este mensaje al camino **On Error** del bloque External Request (haz clic en el punto rojo del bloque y arrástralo hacia este mensaje).

---

### 1.6 Configurar revisión por Telegram (obligatorio en v3)

El bridge requiere un canal de revisión para aprobar o editar respuestas:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_REVIEW_CHAT_ID`
- `TELEGRAM_WEBHOOK_PATH_TOKEN` (token aleatorio para la ruta)
- `TELEGRAM_WEBHOOK_SECRET` (token secreto para header de Telegram)

Webhook que debe recibir Telegram:

```
https://bot.superwave.ai/telegram/webhook/<TELEGRAM_WEBHOOK_PATH_TOKEN>
```

Registrar webhook (ejemplo):

```bash
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=https://bot.superwave.ai/telegram/webhook/${TELEGRAM_WEBHOOK_PATH_TOKEN}" \
  -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  -d "allowed_updates=[\"message\",\"edited_message\"]"
```

Comandos de revisión:

- Aprobar sugerencia del agente: `/approve <review_id>`
- Enviar respuesta custom: `/reply <review_id> <texto>`
- Ver pendientes: `/pending`
- Ayuda rápida: `/help`

También puedes escribir mensajes normales (sin `/`) y el agente responderá en ese chat para asistir a tu equipo con contexto de leads pendientes.

---

## Parte 2 — Configurar el Default Reply por canal

Para asegurarte de que el flujo se activa en todos los canales:

### WhatsApp

1. Ve a **Settings** (menú izquierdo) → **WhatsApp**.
2. Despázate hasta la sección **Default Reply**.
3. Haz clic en **Set Default Reply**.
4. Selecciona el flujo `Superwave — Lead Intake`.
5. Haz clic en **Save**.

### Facebook Messenger

1. Ve a **Settings** → **Messenger**.
2. Busca **Default Reply**.
3. Selecciona el flujo `Superwave — Lead Intake`.
4. Guarda.

### Instagram

1. Ve a **Settings** → **Instagram**.
2. Busca **Default Reply**.
3. Selecciona el flujo `Superwave — Lead Intake`.
4. Guarda.

### TikTok

1. Ve a **Settings** → **TikTok**.
2. Repite el proceso anterior.

---

## Parte 3 — Configurar el Welcome Message (opcional)

El Welcome Message se activa cuando alguien inicia una conversación por primera vez.

1. Ve a **Settings** → **Messenger** (o WhatsApp) → **Welcome Message**.
2. Haz clic en el flujo actual o en **Create New**.
3. Agrega un mensaje de bienvenida:
   ```
   ¡Hola! Bienvenido a Superwave. 🤝

   Soy el asistente virtual de Superwave. ¿En qué puedo ayudarte hoy?
   ```
4. Opcionalmente, agrega botones de respuesta rápida:
   - `Tuve un accidente`
   - `Mi aseguradora no paga`
   - `Quiero una cita`
   - `Ver información`
5. Conecta cada botón al flujo `Superwave — Lead Intake` para que el mensaje del botón se procese normalmente.

---

## Parte 4 — Probar el flujo

### Prueba desde el panel de ManyChat

1. En el canvas del flujo, haz clic en **Preview** (botón superior derecho).
2. ManyChat abrirá Messenger con el flujo activo.
3. Escribe cualquier mensaje y verifica que llegue el ACK.
4. En Telegram, aprueba (`/approve`) o edita (`/reply`) y confirma que llegue la respuesta final al cliente.

### Prueba manual del webhook

Desde terminal, puedes probar el bridge directamente:

```bash
curl -X POST https://bot.superwave.ai/manychat/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "subscriber_id": "test-123",
    "first_name": "Juan",
    "last_name": "Pérez",
    "last_input_text": "Hola, tuve un accidente y la aseguradora no me quiere indemnizar",
    "channel": "messenger",
    "email": "",
    "phone": ""
  }'
```

Respuesta esperada:
```json
{
  "version": "v2",
  "content": {
    "messages": [
      {
        "type": "text",
        "text": "Gracias por tu mensaje. Un asesor revisará tu caso y te responderá en breve."
      }
    ]
  },
  "review_id": "rvw_abc123...",
  "classification": "consulta_legal"
}
```

---

## Parte 5 — Variables ManyChat disponibles

Al construir el body del External Request, estas son las variables más útiles:

| Variable ManyChat | Descripción |
|---|---|
| `{{subscriber:id}}` | ID único del suscriptor |
| `{{subscriber:first_name}}` | Nombre |
| `{{subscriber:last_name}}` | Apellido |
| `{{subscriber:email}}` | Email (si disponible) |
| `{{subscriber:phone}}` | Teléfono (si disponible) |
| `{{last_input:text}}` | Último mensaje de texto del usuario |
| `{{channel}}` | Canal activo (messenger, instagram, whatsapp) |

---

## Parte 6 — Flujos adicionales recomendados

### Flujo: Agendar Cita

1. Crea un nuevo flujo: `Superwave — Agendar Cita`.
2. Trigger: keyword `cita` o `agendar` (ve a **Growth Tools** → **Keywords**).
3. Pasos:
   - Mensaje: "Con gusto te ayudo a agendar una cita. ¿Me puedes dar tu nombre completo?"
   - User Input: guarda en `{{custom:nombre_completo}}`
   - Mensaje: "Gracias. ¿Y tu número de teléfono de contacto?"
   - User Input: guarda en `{{custom:telefono}}`
   - External Request al bridge con el mensaje completo.
   - Mensaje de confirmación: "¡Listo! Un asesor se comunicará contigo en breve al {{custom:telefono}}."

### Flujo: Precalificación

1. Crea un nuevo flujo: `Superwave — Precalificación`.
2. Trigger: keywords `curp`, `nss`, `crédito`, `préstamo`.
3. Pasos:
   - Mensaje explicativo del proceso.
   - User Input para CURP → guarda en `{{custom:CURP}}`.
   - User Input para NSS → guarda en `{{custom:NSS}}`.
   - External Request al bridge con los datos.

---

## Solución de problemas

| Problema | Causa probable | Solución |
|---|---|---|
| El External Request da timeout | El agente tarda >30s | Verifica `docker compose logs agent` y asegura que el modelo LLM responde |
| Response body vacío | Error en el bridge | Revisa `docker compose logs bridge` para el detalle del error |
| El Default Reply no se activa | Hay otro flujo con ese trigger | Elimina el Default Reply de otros flujos |
| Tags no se asignan | ManyChat API key incorrecta o campos no creados | Corre `./setup-manychat.sh` y verifica `MANYCHAT_API_KEY` |
| No llega mensaje al canal de revisión Telegram | Webhook de Telegram no configurado o token incorrecto | Ejecuta `setWebhook` de la sección 1.6 y valida `TELEGRAM_WEBHOOK_*` |
| Se aprueba en Telegram pero no responde al cliente | Error al enviar por ManyChat API | Revisa `docker compose logs bridge` y valida `MANYCHAT_API_KEY` + ventana de mensajería del canal |
| No aparece lead en kanban | API del dashboard no disponible o objeto incorrecto | Verifica `KANBAN_API_BASE_URL`, `KANBAN_OBJECT_NAME` y que `web` esté healthy |
