// ─────────────────────────────────────────────────────────────────
// agentic-mcp-server / src/defaults.ts
// Default project conventions — seeded into KV on first deploy.
// Edit these to match your actual project standards.
// ─────────────────────────────────────────────────────────────────

import type { ProjectConventions } from "./types";

export const DEFAULT_CONVENTIONS: ProjectConventions = {
  lastUpdated: new Date().toISOString(),

  cloudflare: {
    workerPatterns: [
      "Workers use ES modules format (export default { fetch })",
      "Use Hono for routing within Workers when multiple routes are needed",
      "Environment variables accessed via env parameter, never process.env",
      "Secrets stored via `wrangler secret put` — never in wrangler.jsonc",
      "KV keys use colon-separated namespacing: 'entity:id:subkey'",
      "Workers should handle CORS explicitly — set Access-Control-Allow-Origin",
      "Use waitUntil() for non-blocking background tasks (logging, analytics)",
    ],
    pagesPatterns: [
      "Pages functions in /functions directory using file-based routing",
      "Static assets served directly — no Worker needed for pure static",
      "_routes.json to control which paths go through Functions vs static",
      "Use Pages for frontend; Workers for API/edge logic",
    ],
    kvNamingConvention: "entity:id:subkey — e.g. user:abc123:prefs or feature:feat-001",
    durableObjectPatterns: [
      "One Durable Object per stateful entity (session, room, user)",
      "Use SQLite storage (ctx.storage.sql) for structured data within a DO",
      "Implement WebSocket hibernation for long-lived connections",
      "Never store secrets in DO state — read from env bindings",
      "DO methods should be idempotent where possible",
    ],
  },

  gcp: {
    cloudRunPatterns: [
      "Services are stateless — all state in Firestore or external storage",
      "Use Cloud Run min-instances=1 for latency-sensitive services",
      "Health check endpoint at /healthz returning 200 with JSON status",
      "Environment variables via Cloud Run env vars or Secret Manager",
      "Container images tagged with git SHA — never use 'latest' in prod",
      "Services authenticate with Workload Identity — no service account keys",
      "Request timeout set to 60s for API services, 3600s for background jobs",
    ],
    firestoreCollections: [
      "users/{userId}",
      "projects/{projectId}",
      "projects/{projectId}/features/{featureId}",
      "sessions/{sessionId}",
      "auditLog/{logId}",
    ],
    regionDefault: "us-central1",
  },

  github: {
    branchNamingConvention: "feat/short-description | fix/issue-description | chore/description",
    commitMessageFormat:
      "type(scope): short description\n\n" +
      "Types: feat, fix, chore, docs, test, refactor, perf\n" +
      "Scope: worker, pages, cloudrun, firestore, ci, deps\n" +
      "Example: feat(worker): add rate limiting to auth endpoint",
    prTemplate:
      "## What\n<!-- What does this PR do? -->\n\n" +
      "## Why\n<!-- Why is this change needed? -->\n\n" +
      "## How\n<!-- Key implementation decisions -->\n\n" +
      "## Testing\n<!-- How was this tested? -->\n\n" +
      "## Checklist\n" +
      "- [ ] Tests added/updated\n" +
      "- [ ] AGENTS.md updated if conventions changed\n" +
      "- [ ] No secrets in code\n" +
      "- [ ] Deployed to staging and verified",
  },

  testing: {
    framework: "Vitest for Workers/Pages (via @cloudflare/vitest-pool-workers); pytest for Cloud Run",
    minCoverage: 80,
    e2ePatterns: [
      "E2E tests in /tests/e2e — run against staging environment",
      "Use Playwright for Pages/UI e2e",
      "API e2e tests use supertest or native fetch against staging URL",
      "Each new feature requires at least one happy-path e2e test",
    ],
  },

  codeStyle: {
    language: "TypeScript (Workers/Pages) | Python 3.12+ (Cloud Run)",
    formatter: "Prettier (TS) | Black (Python)",
    linter: "ESLint with @typescript-eslint (TS) | Ruff (Python)",
  },
};
