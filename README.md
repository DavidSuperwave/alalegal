<div align="center">
  <h1>Superwave Agent</h1>
  <p><strong>AI Agent Platform — Deploy intelligent agents for your business</strong></p>
</div>

---

Originally forked from the OpenClaw/IronClaw codebase and rebranded for Superwave's multi-channel agent deployment platform.

## Features

- **Chat Interface** — Streaming responses, chain-of-thought timeline, markdown rendering, file mentions, and rich message artifacts
- **Workspace Shell** — Sidebar with file manager tree, knowledge base navigation, and database browsing/query views
- **Object Management** — TanStack-powered object tables with sorting, filtering, row selection, inline edits, and bulk operations
- **Pipeline/Kanban** — Drag-and-drop kanban boards that update entries and enum stages
- **Entry Detail Modals** — Per-entry field editing with relation metadata and media-aware workflows
- **Reports & Charts** — Interactive report cards with bar/line/area/pie/donut/funnel/scatter/radar chart panels and filter bars
- **Document Editor** — TipTap markdown editor with embedded live report blocks
- **Media Viewer** — Native previews for images, video, audio, and PDF documents
- **Memory System** — Persistent workspace with file-based memory and semantic search (pgvector)
- **Jobs & Routines** — Schedule and monitor agent tasks, create recurring routines
- **Extensions** — Install WASM-based tools and MCP servers to expand capabilities
- **Skills** — Browse and install skills from the registry
- **Multi-Channel** — Telegram, Discord, Slack, WhatsApp, Signal, and HTTP webhooks
- **Logs** — Real-time log streaming with level filtering

## Web UI Parity Status

- `apps/web`: Selective parity audit against `DenchHQ/ironclaw` completed for chat/workspace/table/kanban/report/editor/media surfaces.
- Current result: targeted Web UI feature set is already in parity; only intentional branding deltas are kept (`Superwave` labels/links).
- Out-of-scope gaps still missing in this repo: `apps/ios`, `apps/android`, and `apps/macos`.

## Quick Start (Docker)

### Prerequisites

- Docker & Docker Compose
- PostgreSQL 15+ with pgvector extension
- An LLM API key (Anthropic Claude, OpenAI, or OpenRouter)

### 1. Clone and configure

```bash
git clone https://github.com/DavidSuperwave/superwave-agent.git
cd superwave-agent
cp .env.example .env
```

Edit `.env` with your settings:

```env
DATABASE_URL=postgres://superwave:yourpassword@db:5432/superwave
GATEWAY_AUTH_TOKEN=your-secret-token-here

# Choose your LLM provider:
LLM_BACKEND=anthropic
ANTHROPIC_API_KEY=sk-ant-...
LLM_MODEL=claude-sonnet-4-20250514
```

### 2. Start with Docker

```bash
# Build the image
docker build --platform linux/amd64 -t superwave-agent:latest .

# Run with PostgreSQL
docker run --env-file .env -p 3000:3000 superwave-agent:latest
```

### 3. Access the web UI

Open `http://localhost:3000` and enter your `GATEWAY_AUTH_TOKEN`.

## Development (from source)

### Prerequisites

- Rust 1.92+
- PostgreSQL 15+ with pgvector
- WASM toolchain: `rustup target add wasm32-wasip2 && cargo install wasm-tools`

### Build and run

```bash
createdb superwave
psql superwave -c "CREATE EXTENSION IF NOT EXISTS vector;"

cargo build --release
./target/release/superwave-agent run
```

## Deployment (Digital Ocean)

See `DEPLOY.md` for full Digital Ocean droplet deployment instructions.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `GATEWAY_AUTH_TOKEN` | Yes | Auth token for the web UI |
| `LLM_BACKEND` | Yes | LLM provider (anthropic, openai, openai_compatible) |
| `LLM_MODEL` | No | Model name (default depends on backend) |
| `ANTHROPIC_API_KEY` | If using Anthropic | Claude API key |
| `AGENT_NAME` | No | Agent display name (default: superwave) |
| `TELEGRAM_BOT_TOKEN` | No | For Telegram channel |
| `HTTP_PORT` | No | Webhook server port (default: 8080) |

## License

MIT OR Apache-2.0
