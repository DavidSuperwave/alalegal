# MANYCHAT-FLOW — Configuración de Flujos en ManyChat

> Esta guía explica exactamente cómo configurar ManyChat para que cada mensaje del usuario sea procesado por el bridge de Superwave.

---

## Arquitectura del flujo

```
Usuario (WhatsApp / Messenger / Instagram / TikTok)
    ↓  escribe un mensaje
ManyChat recibe el mensaje
    ↓  activa el "Default Reply"
Flow: Superwave — Respuesta Automática
    ↓  acción: External Request (HTTP POST)
Bridge en bot.superwave.ai:4000
    ↓  clasifica + enriquece + forward
Superwave Agent (Claude vía OpenRouter)
    ↓  genera respuesta en español
Bridge devuelve la respuesta
    ↓  ManyChat la envía al usuario
```

---

## Parte 1 — Crear el flujo principal

### 1.1 Navegar a Flows

1. Entra a [manychat.com](https://manychat.com) y selecciona tu página.
2. En el menú lateral izquierdo, haz clic en **Flows**.
3. Haz clic en el botón azul **+ New Flow** (esquina superior derecha).
4. Nombra el flujo: `Superwave — Respuesta Automática`.
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

Después de la acción External Request, debes mostrar la respuesta al usuario.

#### Opción A — Dynamic Response (recomendada)

ManyChat soporta respuestas dinámicas directamente del External Request si el body de respuesta sigue el formato ManyChat v2:

```json
{
  "version": "v2",
  "content": {
    "messages": [
      { "type": "text", "text": "Hola, te puedo ayudar..." }
    ]
  }
}
```

El bridge ya devuelve este formato. Para activarlo:

1. En la acción External Request, ve a la sección **Response**.
2. Haz clic en **+ Add Response Mapping**.
3. En **Field to save**, selecciona o crea el Custom Field `ultima_clasificacion`.
4. En **JSONPath**, ingresa: `$.response` (o `$.content.messages[0].text`).
5. Activa la opción **"Use response as message"** si está disponible en tu versión de ManyChat.

#### Opción B — Guardar y enviar (más compatible)

1. En la acción External Request → Response, agrega un mapping:
   - **JSONPath:** `$.content.messages[0].text`
   - **Save to Custom Field:** crea o selecciona `respuesta_bot` (tipo Text)

2. Después del bloque External Request, agrega un paso **Message**.

3. En el mensaje, escribe `{{custom:respuesta_bot}}` — esto mostrará la respuesta del bot.

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

## Parte 2 — Configurar el Default Reply por canal

Para asegurarte de que el flujo se activa en todos los canales:

### WhatsApp

1. Ve a **Settings** (menú izquierdo) → **WhatsApp**.
2. Despázate hasta la sección **Default Reply**.
3. Haz clic en **Set Default Reply**.
4. Selecciona el flujo `Superwave — Respuesta Automática`.
5. Haz clic en **Save**.

### Facebook Messenger

1. Ve a **Settings** → **Messenger**.
2. Busca **Default Reply**.
3. Selecciona el flujo `Superwave — Respuesta Automática`.
4. Guarda.

### Instagram

1. Ve a **Settings** → **Instagram**.
2. Busca **Default Reply**.
3. Selecciona el flujo `Superwave — Respuesta Automática`.
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
5. Conecta cada botón al flujo `Superwave — Respuesta Automática` para que el mensaje del botón se procese normalmente.

---

## Parte 4 — Probar el flujo

### Prueba desde el panel de ManyChat

1. En el canvas del flujo, haz clic en **Preview** (botón superior derecho).
2. ManyChat abrirá Messenger con el flujo activo.
3. Escribe cualquier mensaje y verifica que el bot responda.

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
        "text": "Hola Juan, mucho gusto. Lamento mucho lo que estás pasando..."
      }
    ]
  }
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
| Mensajes no aparecen en Supabase | `SUPABASE_URL` o `SUPABASE_KEY` incorrectos | Verifica las variables y que corriste `supabase-migration.sql` |
