# AGENTS.md — agentic-mcp-server

> **Read this file first.** All AI agents working in this repo must read this file
> before writing any code. It is the single source of truth for how this project works.

---

## What is this repo?

`agentic-mcp-server` is a remote MCP (Model Context Protocol) server deployed on
**Cloudflare Workers + Durable Objects**. It connects AI agents (Claude, CodeGPT,
Roo Code) so they can share context, coordinate tasks, and maintain state across sessions.

---

## Stack

| Layer | Technology |
|---|---|
| Compute | Cloudflare Workers |
| Stateful sessions | Cloudflare Durable Objects (SQLite) |
| Shared context | Cloudflare KV |
| Language | TypeScript 5.5+ |
| Runtime | Workers runtime (V8 isolates — NOT Node.js) |
| Deploy | Wrangler CLI via GitHub Actions |
| Schema validation | Zod |
| MCP SDK | `agents` package (Cloudflare's McpAgent wrapper) |

---

## Agent Roles

Each connecting agent declares a role via `?role=` query param:

| Role | Responsibility | Example Agent |
|---|---|---|
| `planner` | Feature specs, task breakdown, PRDs | Claude (claude.ai) |
| `frontend` | Cloudflare Workers, Pages, edge logic | Roo Code / Claude Code |
| `backend` | Cloud Run services, Firestore, APIs | CodeGPT (GPT-5.2-Codex) |
| `tester` | Test generation, debug, coverage | Roo Code debug mode |
| `reviewer` | PR review, security, conventions | Claude Code |
| `orchestrator` | Coordinates agents, updates conventions | Human / lead agent |

---

## Connecting to the MCP Server

### Claude Code (terminal)
```bash
claude mcp add agentic-mcp \
  --url https://agentic-mcp-server.YOUR_ACCOUNT.workers.dev/mcp \
  --params "role=frontend&name=claude-code"
```

### CodeGPT (VSCode extension)
In CodeGPT settings → MCP Servers → Add Remote:
```
URL: https://agentic-mcp-server.YOUR_ACCOUNT.workers.dev/mcp?role=backend&name=codegpt
Transport: Streamable HTTP
```

### Roo Code (VSCode extension)
In `.roo/mcp.json`:
```json
{
  "mcpServers": {
    "agentic-mcp": {
      "url": "https://agentic-mcp-server.YOUR_ACCOUNT.workers.dev/mcp",
      "params": { "role": "tester", "name": "roo-code" }
    }
  }
}
```

### Claude Desktop
In `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "agentic-mcp": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://agentic-mcp-server.YOUR_ACCOUNT.workers.dev/mcp?role=planner&name=claude-desktop"
      ]
    }
  }
}
```

---

## Available MCP Tools

| Tool | Who Uses It | What It Does |
|---|---|---|
| `get_conventions` | All agents, session start | Fetch coding standards |
| `get_feature_spec` | All agents | Read a feature's spec and tasks |
| `list_features` | All agents | See all features and their status |
| `upsert_feature_spec` | Planner, then others | Create/update feature specs |
| `update_task_status` | All agents | Mark tasks in-progress/done/blocked |
| `update_session_notes` | All agents | Save working notes (survives hibernation) |
| `read_shared_memory` | All agents | Read cross-agent shared KV memory |
| `write_shared_memory` | All agents | Write to shared KV memory |
| `get_session_state` | All agents | Check own session/role/progress |
| `update_conventions` | Planner/Orchestrator only | Update global coding conventions |

---

## Development Workflow

### Starting a new feature
1. **Planner agent** calls `upsert_feature_spec` with title, description, and task breakdown
2. Each task gets assigned to a role (`backend`, `frontend`, `tester`, etc.)
3. Agents call `get_feature_spec` to read their assigned tasks
4. Each agent calls `update_task_status` as they progress
5. Agents use `write_shared_memory` to share API contracts and decisions
6. Human reviews, merges PR, and marks feature done

### Resuming after a break
1. Call `get_session_state` to see your notes and active feature
2. Call `get_feature_spec` to see current task status
3. Read `shared_memory` to catch up on cross-agent decisions
4. Continue where you left off

---

## Key Files

```
src/
  index.ts        — Worker entry point + AgenticMcpAgent Durable Object
  tools.ts        — MCP tool input schemas (Zod)
  types.ts        — TypeScript types for sessions, features, conventions
  defaults.ts     — Default project conventions seeded on first deploy
wrangler.jsonc    — Cloudflare deployment config
AGENTS.md         — This file
```

---

## Deployment

```bash
# Install dependencies
npm install

# Create KV namespace
wrangler kv namespace create SHARED_CONTEXT
# Copy the ID into wrangler.jsonc

# Set secrets
wrangler secret put AUTH_SECRET      # random 32-char string
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET

# Deploy
npm run deploy

# Tail logs in production
npm run tail
```

---

## Important Rules for All Agents

1. **Always call `get_conventions` first** in a new session
2. **Never hardcode secrets** — use `env.SECRET_NAME` bindings
3. **Never use Node.js APIs** — this is a Workers runtime (no `fs`, `path`, `process`)
4. **Persist working state** — call `update_session_notes` regularly so you can resume
5. **Communicate cross-agent decisions** — use `write_shared_memory` for API contracts
6. **Mark tasks as you go** — call `update_task_status` so other agents know what's done
7. **One PR per feature** — branch naming: `feat/feature-id-short-description`
