# ManyChat Integration Guide

## Architecture

```
Instagram/FB/WhatsApp User
        ↓ sends DM
    ManyChat
        ↓ External Request (POST)
    ManyChat Bridge (:4000)
        ↓ translates payload + forwards
    Superwave Agent (:8080/webhook)
        ↓ AI processes message
    ManyChat Bridge
        ↓ calls ManyChat sendContent API
    ManyChat
        ↓ delivers reply
Instagram/FB/WhatsApp User sees response
```

## Prerequisites

- ManyChat Pro account (External Request is a Pro feature)
- ManyChat API key (you already have this: `Bearer 416263294908731:...`)
- Superwave Agent deployed with HTTPS (ManyChat requires HTTPS for webhooks)

---

## Step 1: Configure Your .env

Add these to your `.env` file:

```env
# ManyChat Bridge
MANYCHAT_API_KEY=Bearer 416263294908731:439fac70ed0bca6edeb1956172e1beab
SUPERWAVE_WEBHOOK_SECRET=your-random-webhook-secret-here
BRIDGE_SECRET=optional-secret-manychat-sends

# Superwave Agent (choose your LLM)
GATEWAY_AUTH_TOKEN=your-web-ui-password
LLM_BACKEND=anthropic
ANTHROPIC_API_KEY=sk-ant-your-key
LLM_MODEL=claude-sonnet-4-20250514
DB_PASSWORD=superwave-secret
```

## Step 2: Deploy with Docker Compose

```bash
cd /path/to/superwave-agent
docker compose up -d
```

This starts three services:
- **db** — PostgreSQL 16 + pgvector on port 5432
- **agent** — Superwave Agent on port 3000 (web UI) + 8080 (webhooks)
- **bridge** — ManyChat Bridge on port 4000

## Step 3: Set Up Nginx (HTTPS required for ManyChat)

Add this to your Nginx config alongside the existing Superwave server block:

```nginx
# ManyChat webhook endpoint
location /manychat/ {
    proxy_pass http://127.0.0.1:4000/manychat/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 60;
}
```

After adding, reload: `nginx -t && systemctl reload nginx`

Your ManyChat webhook URL will be: `https://yourdomain.com/manychat/webhook`

---

## Step 4: Configure ManyChat

### 4A: Create the "AI Reply" Flow

1. Go to **ManyChat** → **Automation** → **Flows**
2. Click **+ New Flow** → name it "AI Agent Reply"
3. Add a **Starting Step** → choose your trigger:
   - **Default Reply** (catches all unmatched messages) — recommended
   - Or a specific **Keyword** trigger
   - Or a **User Input** block

### 4B: Add the External Request Action

1. After your trigger, click **+** → **Action** → **External Request**
2. Configure:
   - **Request Type**: POST
   - **Request URL**: `https://yourdomain.com/manychat/webhook`
   - **Headers**: *(none needed — auth is in the body)*
   - **Request Body** (JSON):

```json
{
  "subscriber_id": "{{user_id}}",
  "first_name": "{{first_name}}",
  "last_name": "{{last_name}}",
  "last_input_text": "{{last_input_text}}",
  "channel": "instagram",
  "email": "{{email}}",
  "phone": "{{phone}}"
}
```

> **Important**: Change `"channel"` to match your platform:
> - `"instagram"` for Instagram
> - `"messenger"` for Facebook Messenger  
> - `"whatsapp"` for WhatsApp

3. If you set `BRIDGE_SECRET` in your .env, add it to the body:
```json
{
  "secret": "your-bridge-secret",
  "subscriber_id": "{{user_id}}",
  ...
}
```

### 4C: Map the Response (Optional)

The bridge returns JSON that ManyChat can map to Custom User Fields:

```json
{
  "version": "v2",
  "content": {
    "messages": [
      { "type": "text", "text": "The AI's reply text..." }
    ]
  }
}
```

In the **Response Mapping** tab:
- Create a Custom User Field called `ai_response` (Text type)
- Map `$.content.messages[0].text` → `ai_response`

This lets you use `{{ai_response}}` in subsequent ManyChat messages.

### 4D: Set as Default Reply (recommended)

1. Go to **Automation** → **Default Reply**
2. Set it to trigger your "AI Agent Reply" flow
3. This way, any message that doesn't match a specific ManyChat keyword gets routed to Superwave

---

## Step 5: Test It

1. Open your Instagram/FB/WhatsApp connected to ManyChat
2. Send a message from a test account
3. Check the bridge logs: `docker compose logs -f bridge`
4. You should see:
   ```
   [ManyChat →] Incoming: {"subscriber_id":"123",...}
   [→ Superwave] Forwarding: "hello" from David (123)
   [← Superwave] Response: {"response":"Hi David! How can I help..."}
   [→ ManyChat] Sending reply to 123 via instagram
   [← ManyChat] Reply sent successfully to 123
   ```
5. The reply appears in the user's DM

---

## Multi-Channel Setup

### Instagram
```json
{ "channel": "instagram", ... }
```
Uses ManyChat `/fb/sending/sendContent` (same as Messenger)

### Facebook Messenger
```json
{ "channel": "messenger", ... }
```
Uses ManyChat `/fb/sending/sendContent`

### WhatsApp
```json
{ "channel": "whatsapp", ... }
```
Uses ManyChat `/wa/sending/sendContent`

> **WhatsApp note**: For first-contact messages, WhatsApp requires an **approved Message Template**. The bridge handles text replies within an active 24-hour messaging window. For cold outreach, use ManyChat's Flow-based approach with `/wa/sending/sendFlow`.

---

## Troubleshooting

### "subscriber_id cannot be blank"
Make sure you're sending `subscriber_id` (not `subscriberId`) and it's the ManyChat user ID, which you can get from `{{user_id}}` in ManyChat.

### "Subscriber does not exist"
The subscriber ID must match an existing ManyChat contact. This is automatic when using `{{user_id}}` in a flow triggered by that user's message.

### Bridge not receiving requests
- Confirm your URL is HTTPS (ManyChat won't call HTTP)
- Check Nginx is proxying `/manychat/` to port 4000
- Test with: `curl -X POST https://yourdomain.com/manychat/webhook -H "Content-Type: application/json" -d '{"subscriber_id":"test","last_input_text":"hello"}'`

### Agent returns timeout
The bridge waits 55 seconds for the AI response. If your LLM is slow, the request may time out. Check:
- `docker compose logs agent` for processing time
- Consider a faster model if response times exceed 30s

### WhatsApp 24-hour window
WhatsApp only allows free-form messages within 24 hours of the user's last message. Outside this window, you must use approved templates via `sendFlow`.

---

## File Structure

```
superwave-agent/
├── docker-compose.yml        ← Runs everything
├── .env                      ← Your secrets
├── Dockerfile                ← Superwave Agent (Rust)
├── manychat-bridge/
│   ├── Dockerfile            ← Bridge container
│   ├── package.json
│   └── bridge.js             ← Bridge logic
└── src/                      ← Superwave Agent source
```
