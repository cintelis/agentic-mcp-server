# Mission Control Dashboard — Documentation

> **agentic-mcp-server** · Real-time observability for multi-agent development workflows

---

## Overview

Mission Control is a real-time dashboard for monitoring AI agents connected to the `agentic-mcp-server`. It shows which agents are active, what features are being worked on, every tool call as it happens, and aggregated usage statistics — all updating live via WebSocket.

**Live URL:** `https://agentic-dashboard.365softlabs.com`  
**Worker API:** `https://agentic-mcp-server.{account}.workers.dev`

---

## Architecture & Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        AI AGENTS (Clients)                          │
│                                                                     │
│   Claude Desktop    Claude Code    Roo Code    CodeGPT             │
│   role=planner      role=frontend  role=tester role=backend        │
└────────────────────────────┬────────────────────────────────────────┘
                             │ MCP over HTTP/SSE
                             │ POST /mcp?role=X&name=Y
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   CLOUDFLARE WORKER                                 │
│                   agentic-mcp-server                                │
│                                                                     │
│  ┌──────────────────────────────┐  ┌────────────────────────────┐  │
│  │   AgenticMcpAgent DO         │  │   DashboardBroadcaster DO  │  │
│  │   (one per agent session)    │  │   (one global instance)    │  │
│  │                              │  │                            │  │
│  │  • Handles MCP tool calls    │  │  • Holds all WebSocket     │  │
│  │  • Wraps every tool in       │  │    connections from        │  │
│  │    callTool() logger         │  │    dashboard clients       │  │
│  │  • Persists session state    │  │  • Fans out events to      │  │
│  │    in Durable Object storage │  │    all connected dashboards│  │
│  │  • Calls logActivity() +     │  │                            │  │
│  │    broadcast() after         │  │  POST /broadcast           │  │
│  │    every tool call           │  │  GET  /ws (WebSocket)      │  │
│  └──────────┬───────────────────┘  └────────────▲───────────────┘  │
│             │                                    │                  │
│             │ fire-and-forget                    │ broadcast event  │
│             ▼                                    │                  │
│  ┌──────────────────────────────┐                │                  │
│  │   Cloudflare KV              │                │                  │
│  │   SHARED_CONTEXT             │                │                  │
│  │                              │                │                  │
│  │  dashboard:sessions          │                │                  │
│  │  dashboard:activity:log      │                │                  │
│  │  dashboard:stats             │                │                  │
│  │  feature:{id}                │                │                  │
│  │  feature:index               │                │                  │
│  │  conventions:global          │                │                  │
│  │  memory:{role}               │                │                  │
│  │  notes:shared                │                │                  │
│  └──────────────────────────────┘                │                  │
│                                                  │                  │
│  Dashboard API Routes:                           │                  │
│  GET /dashboard/api/sessions   ─────────────────►│                  │
│  GET /dashboard/api/features   ─────────────────►│                  │
│  GET /dashboard/api/activity   ─────────────────►│                  │
│  GET /dashboard/api/stats      ─────────────────►│                  │
│  GET /dashboard/ws (WebSocket) ──────────────────┘                  │
└─────────────────────────────────────────────────────────────────────┘
                             │
                             │ REST API + WebSocket
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   CLOUDFLARE PAGES                                  │
│                   agentic-mcp-dashboard                             │
│                                                                     │
│   React SPA (Vite build)                                            │
│   https://agentic-dashboard.365softlabs.com                        │
│                                                                     │
│   • Initial load: fetches all 4 API endpoints in parallel          │
│   • Real-time: WebSocket receives events and updates UI instantly   │
│   • Fallback: polls all endpoints every 30 seconds                 │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow Detail

### 1. Agent Connects

When an AI agent connects to `/mcp?role=frontend&name=claude-code`:

1. A new `AgenticMcpAgent` Durable Object is created (or existing one resumed)
2. `init()` runs — restores session state from DO storage
3. `registerSession()` writes the session to `dashboard:sessions` in KV
4. Dashboard receives no real-time event for this (sessions are polled)

### 2. Agent Calls a Tool

Every tool call (e.g. `get_feature_spec`, `update_task_status`) is wrapped in `callTool()`:

```
Agent → tool call → callTool() wrapper
                         │
                         ├─► executes the actual tool fn
                         │
                         └─► in finally block (fire-and-forget):
                               ├─► logActivity() → writes to KV
                               │     dashboard:activity:log (last 200 events)
                               │     dashboard:stats (aggregated counters)
                               │
                               ├─► broadcast() → POST to DashboardBroadcaster DO
                               │     fans out to all WebSocket clients
                               │
                               └─► touchSession() → updates session lastActiveAt in KV
```

### 3. Dashboard Receives Event

The WebSocket client in the dashboard (`hooks.ts`) receives the broadcast and immediately updates React state — no re-fetch needed:

| Event Type | What Updates |
|---|---|
| `tool_call` | Activity feed prepended, session `lastActiveAt` updated |
| `feature_updated` | Kanban board card updated or new card added |
| `task_updated` | Task chip status updated within feature card |
| `memory_written` | No UI update (logged only) |

---

## API Endpoints

All endpoints are served by the Worker at `/dashboard/api/*`.

### `GET /dashboard/api/sessions`

Returns the session registry — all known agent sessions.

```json
{
  "sessions": {
    "session-id-xyz": {
      "sessionId": "session-id-xyz",
      "agentRole": "frontend",
      "agentName": "claude-code",
      "createdAt": "2026-02-28T10:00:00Z",
      "lastActiveAt": "2026-02-28T11:30:00Z",
      "currentFeature": "feat-001",
      "currentTask": "feat-001-task-2",
      "isActive": true
    }
  }
}
```

Sessions inactive for more than 2 hours are automatically marked `isActive: false`.

### `GET /dashboard/api/features`

Returns all feature specs stored in KV.

```json
[
  {
    "id": "feat-001",
    "title": "User Authentication",
    "description": "OAuth2 login via GitHub",
    "status": "in-progress",
    "createdAt": "2026-02-28T09:00:00Z",
    "updatedAt": "2026-02-28T11:00:00Z",
    "tasks": [
      {
        "id": "feat-001-task-1",
        "title": "Design auth flow",
        "assignedRole": "planner",
        "status": "done",
        "completedAt": "2026-02-28T10:00:00Z"
      },
      {
        "id": "feat-001-task-2",
        "title": "Implement Worker endpoint",
        "assignedRole": "frontend",
        "status": "in-progress"
      }
    ],
    "assignedAgents": {
      "planner": "claude-desktop",
      "frontend": "claude-code"
    },
    "githubBranch": "feat/user-authentication"
  }
]
```

### `GET /dashboard/api/activity?limit=100`

Returns the most recent activity events (default 50, max 200).

```json
[
  {
    "id": "evt-1709118000000-abc12",
    "timestamp": "2026-02-28T11:30:00Z",
    "sessionId": "session-id-xyz",
    "agentRole": "frontend",
    "agentName": "claude-code",
    "tool": "update_task_status",
    "featureId": "feat-001",
    "taskId": "feat-001-task-2",
    "durationMs": 142,
    "success": true
  }
]
```

### `GET /dashboard/api/stats`

Returns aggregated usage statistics.

```json
{
  "lastUpdated": "2026-02-28T11:30:00Z",
  "totalToolCalls": 847,
  "toolCallCounts": {
    "get_feature_spec": 312,
    "update_task_status": 201,
    "write_shared_memory": 98
  },
  "agentCallCounts": {
    "claude-code": 445,
    "codegpt": 312,
    "roo-code": 90
  },
  "roleCallCounts": {
    "frontend": 445,
    "backend": 312,
    "tester": 90,
    "planner": 0,
    "reviewer": 0,
    "orchestrator": 0
  },
  "featureActivityCounts": {
    "feat-001": 523,
    "feat-002": 324
  },
  "dailyCounts": {
    "2026-02-28": 847
  },
  "hourlyActivity": [0,0,0,0,0,0,0,12,45,98,120,87,65,43,21,18,32,54,76,43,21,0,0,0]
}
```

### `GET /dashboard/ws`

WebSocket endpoint. Upgrades to WebSocket and subscribes to real-time broadcast events from `DashboardBroadcaster`.

---

## WebSocket Events

Events pushed to all connected dashboard clients in real time:

### `tool_call`
Fired after every MCP tool invocation.
```json
{
  "type": "tool_call",
  "timestamp": "2026-02-28T11:30:00Z",
  "sessionId": "session-id-xyz",
  "agentRole": "frontend",
  "agentName": "claude-code",
  "tool": "update_task_status",
  "featureId": "feat-001",
  "taskId": "feat-001-task-2",
  "durationMs": 142,
  "success": true
}
```

### `feature_updated`
Fired when `upsert_feature_spec` is called.
```json
{
  "type": "feature_updated",
  "timestamp": "2026-02-28T11:30:00Z",
  "feature": { ...full FeatureSpec object... }
}
```

### `task_updated`
Fired when `update_task_status` is called.
```json
{
  "type": "task_updated",
  "timestamp": "2026-02-28T11:30:00Z",
  "featureId": "feat-001",
  "taskId": "feat-001-task-2",
  "status": "done",
  "agentRole": "frontend",
  "agentName": "claude-code"
}
```

### `memory_written`
Fired when `write_shared_memory` is called.
```json
{
  "type": "memory_written",
  "timestamp": "2026-02-28T11:30:00Z",
  "key": "memory:frontend",
  "role": "frontend",
  "agentName": "claude-code"
}
```

---

## Dashboard UI

### Header Bar

Always visible across the top.

| Element | Description |
|---|---|
| **MISSION CONTROL** logo | App title and branding |
| **UTC Clock** | Live clock updating every second |
| **Active agents** | Count of sessions with `isActive: true`, with pulsing green dot |
| **LIVE / RECONNECTING** | WebSocket connection status — green when connected, red when reconnecting |
| **↺ REFRESH** | Manual trigger to re-fetch all API endpoints |

### Stats Bar

Six metrics displayed as a grid below the header, always visible.

| Metric | Source | Description |
|---|---|---|
| **TOTAL CALLS** | `stats.totalToolCalls` | All-time tool invocations |
| **FEATURES LIVE** | `features` where `status === 'in-progress'` | Currently active features |
| **IN REVIEW** | `features` where `status === 'review'` | Features awaiting review |
| **SHIPPED** | `features` where `status === 'done'` | Completed features |
| **TOP AGENT** | `stats.agentCallCounts` (highest) | Most active agent by name |
| **TOP TOOL** | `stats.toolCallCounts` (highest) | Most called tool |

### Tab: ⊞ Features (Kanban Board)

Four columns representing the feature lifecycle:

```
Planning → In Progress → Review → Done
```

Each feature card shows:
- Feature ID (e.g. `feat-001`) and title
- Progress bar (% of tasks with `status === 'done'`)
- Task count and GitHub branch name (if set)
- Expandable task list — click card to reveal individual tasks with role badges and status dots

Task status colours:
- `todo` → dim grey
- `in-progress` → cyan
- `done` → green
- `blocked` → red

### Tab: ◎ Agents

List of all known agent sessions, sorted by most recently active.

Each session card shows:
- Agent name with status dot (green = active, grey = inactive)
- Role badge (colour-coded by role)
- Current feature being worked on
- Time since last activity

Role colours:
| Role | Colour |
|---|---|
| Planner | Cyan |
| Frontend | Green |
| Backend | Purple |
| Tester | Yellow |
| Reviewer | Orange |
| Orchestrator | Red |

Sessions inactive for >2 hours are automatically marked inactive by the Worker and shown in grey.

### Tab: ⚡ Activity

Live scrolling feed of all tool calls, newest at top. Maximum 100 events shown (last 200 stored in KV).

Each entry shows:
- Tool icon (emoji)
- Agent name (colour-coded by role)
- Tool name called
- Feature ID badge (if applicable)
- Time since event
- Duration in milliseconds
- `ERR` badge if `success === false`

New events arriving via WebSocket briefly highlight in cyan with a slide-in animation.

### Tab: ◈ Stats

Three visualisations:

**Hourly Activity Chart** — 24-bar chart showing tool calls per UTC hour. Current hour highlighted in cyan with glow effect. Resets conceptually per hour (sliding counter).

**Top Tools** — horizontal bar chart of most-called tools, sorted descending.

**Top Agents** — horizontal bar chart of most active agents by name.

**Top Features** — horizontal bar chart of most active features by ID.

---

## KV Data Model

All data is stored in the `SHARED_CONTEXT` KV namespace.

| Key | Type | Description |
|---|---|---|
| `conventions:global` | `ProjectConventions` JSON | Coding standards, read by all agents on session start |
| `feature:index` | `string[]` JSON | List of all feature IDs |
| `feature:{id}` | `FeatureSpec` JSON | Full feature spec including tasks |
| `memory:{role}` | `string` | Role-specific shared memory (e.g. `memory:frontend`) |
| `notes:shared` | `string` | General shared notes visible to all agents |
| `dashboard:sessions` | `SessionRegistry` JSON | All agent session metadata |
| `dashboard:activity:log` | `ActivityEvent[]` JSON | Last 200 tool call events |
| `dashboard:stats` | `AgentStats` JSON | Aggregated counters and hourly chart data |

---

## Connecting an Agent

### Claude Desktop
Add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "agentic-mcp": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://agentic-mcp-server.{account}.workers.dev/mcp?role=planner&name=claude-desktop"
      ]
    }
  }
}
```

### Claude Code (terminal)
```bash
claude mcp add agentic-mcp \
  --url https://agentic-mcp-server.{account}.workers.dev/mcp \
  --params "role=frontend&name=claude-code"
```

### Roo Code
In `.roo/mcp.json`:
```json
{
  "mcpServers": {
    "agentic-mcp": {
      "url": "https://agentic-mcp-server.{account}.workers.dev/mcp",
      "params": { "role": "tester", "name": "roo-code" }
    }
  }
}
```

### CodeGPT
In CodeGPT settings → MCP Servers → Add Remote:
```
URL: https://agentic-mcp-server.{account}.workers.dev/mcp?role=backend&name=codegpt
Transport: Streamable HTTP
```

Once connected, the agent should call `get_conventions` first — this will immediately appear in the Activity feed and increment the stats counters.

---

## Deployment

### Worker
```bash
npx wrangler deploy
```

### Dashboard
```powershell
# From dashboard/ directory
$env:VITE_API_URL="https://agentic-mcp-server.{account}.workers.dev"; npm run build
npx wrangler pages deploy dist --project-name=agentic-mcp-dashboard
```

### Environment Variables (wrangler.jsonc)
| Variable | Value |
|---|---|
| `ENVIRONMENT` | `production` |
| `PROJECT_NAME` | `agentic-mcp-server` |
| `DASHBOARD_ORIGIN` | `https://agentic-dashboard.365softlabs.com` |

### Secrets (set via wrangler secret put)
| Secret | Purpose |
|---|---|
| `AUTH_SECRET` | 32-char random string for session token signing |
| `GITHUB_CLIENT_ID` | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret |
