import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionState, AgentRole, FeatureSpec, Task, ProjectConventions } from "./types";
import { KV_KEYS } from "./types";
import { DEFAULT_CONVENTIONS } from "./defaults";
import { logActivity, registerSession, touchSession } from "./logger";
import { GitHubClient } from "./github";
import {
  GetConventionsInput, GetFeatureSpecInput, ListFeaturesInput,
  UpsertFeatureSpecInput, UpdateTaskStatusInput, UpdateSessionNotesInput,
  ReadSharedMemoryInput, WriteSharedMemoryInput, GetSessionStateInput, UpdateConventionsInput,
  GitHubGetRepoInfoInput, GitHubCreateBranchInput, GitHubOpenPRInput,
  GitHubGetPRInput, GitHubListOpenPRsInput, GitHubAddPRCommentInput, GitHubMergePRInput,
} from "./tools";

// ── DashboardBroadcaster ────────────────────────────────────────
// One global Durable Object that fans WebSocket events to all dashboard clients.
export class DashboardBroadcaster {
  private connections = new Set<WebSocket>();
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/broadcast") {
      const event = await request.json();
      const msg = JSON.stringify(event);
      const dead: WebSocket[] = [];
      for (const ws of this.connections) {
        try { ws.send(msg); } catch { dead.push(ws); }
      }
      dead.forEach(ws => this.connections.delete(ws));
      return new Response("ok");
    }
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const { 0: client, 1: server } = new WebSocketPair();
      this.state.acceptWebSocket(server);
      this.connections.add(server);
      server.addEventListener("close", () => this.connections.delete(server));
      server.addEventListener("error", () => this.connections.delete(server));
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("Not found", { status: 404 });
  }
}

// ── AgenticMcpAgent ─────────────────────────────────────────────
// One Durable Object per agent session.
export class AgenticMcpAgent extends McpAgent {
  server = new McpServer({ name: "agentic-mcp-server", version: "1.0.0" });
  private session!: SessionState;
  private gh!: GitHubClient;

  async init() {
    // Init GitHub client
    this.gh = new GitHubClient(this.env.GITHUB_TOKEN);

    // Restore or create session
    const stored = await this.ctx.storage.get<SessionState>("session");
    if (stored) {
      this.session = stored;
      this.session.lastActiveAt = new Date().toISOString();
    } else {
      const url = new URL(this.ctx.id.toString());
      const role = (url.searchParams.get("role") as AgentRole) ?? "orchestrator";
      const agentName = url.searchParams.get("name") ?? "unknown-agent";
      this.session = {
        sessionId: this.ctx.id.toString(), agentRole: role, agentName,
        createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
        tasksCompleted: [], notes: "",
      };
    }
    await this.persistSession();
    await registerSession(this.env.SHARED_CONTEXT, {
      sessionId: this.session.sessionId, agentRole: this.session.agentRole,
      agentName: this.session.agentName, createdAt: this.session.createdAt,
      lastActiveAt: this.session.lastActiveAt, currentFeature: this.session.currentFeature,
      currentTask: this.session.currentTask,
    });
    this.registerTools();
  }

  // ── Shared infrastructure ──────────────────────────────────────

  private async callTool<T>(
    tool: string,
    featureId: string | undefined,
    taskId: string | undefined,
    fn: () => Promise<T>
  ): Promise<T> {
    const start = Date.now();
    let success = true;
    try {
      return await fn();
    } catch (e) {
      success = false;
      throw e;
    } finally {
      const durationMs = Date.now() - start;
      const evt = {
        timestamp: new Date().toISOString(),
        sessionId: this.session.sessionId,
        agentRole: this.session.agentRole,
        agentName: this.session.agentName,
        tool, featureId, taskId, durationMs, success,
      };
      logActivity(this.env.SHARED_CONTEXT, evt).catch(() => {});
      this.broadcast({ type: "tool_call", ...evt }).catch(() => {});
      touchSession(this.env.SHARED_CONTEXT, this.session.sessionId, {
        lastActiveAt: new Date().toISOString(),
        ...(featureId ? { currentFeature: featureId } : {}),
        ...(taskId ? { currentTask: taskId } : {}),
      }).catch(() => {});
    }
  }

  private async broadcast(event: object): Promise<void> {
    const id = this.env.DASHBOARD_BROADCASTER.idFromName("global");
    const stub = this.env.DASHBOARD_BROADCASTER.get(id);
    await stub.fetch("https://internal/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
  }

  private ok(text: string) {
    return { content: [{ type: "text" as const, text }] };
  }
  private err(text: string) {
    return { content: [{ type: "text" as const, text }], isError: true };
  }

  // ── Tool registration ──────────────────────────────────────────

  private registerTools() {
    // ── Existing tools ────────────────────────────────────────────

    this.server.tool("get_conventions", "Fetch project-wide coding conventions. Call at session start.", GetConventionsInput.shape,
      async () => this.callTool("get_conventions", undefined, undefined, async () => {
        const c = await this.getConventions();
        return this.ok(JSON.stringify(c, null, 2));
      })
    );

    this.server.tool("get_feature_spec", "Retrieve a feature spec.", GetFeatureSpecInput.shape,
      async ({ featureId }) => this.callTool("get_feature_spec", featureId, undefined, async () => {
        const spec = await this.env.SHARED_CONTEXT.get<FeatureSpec>(KV_KEYS.featureSpec(featureId), "json");
        if (!spec) return this.err(`Feature '${featureId}' not found.`);
        return this.ok(JSON.stringify(spec, null, 2));
      })
    );

    this.server.tool("list_features", "List all feature specs.", ListFeaturesInput.shape,
      async ({ status }) => this.callTool("list_features", undefined, undefined, async () => {
        const index = await this.env.SHARED_CONTEXT.get<string[]>(KV_KEYS.featureIndex, "json") ?? [];
        const features: FeatureSpec[] = [];
        for (const id of index) {
          const spec = await this.env.SHARED_CONTEXT.get<FeatureSpec>(KV_KEYS.featureSpec(id), "json");
          if (spec && (status === "all" || spec.status === status)) features.push(spec);
        }
        if (features.length === 0) return this.ok("No features found.");
        return this.ok(JSON.stringify(features.map(f => ({
          id: f.id, title: f.title, status: f.status, taskCount: f.tasks.length,
          githubBranch: f.githubBranch, githubPR: f.githubPR?.number,
        })), null, 2));
      })
    );

    this.server.tool("upsert_feature_spec", "Create or update a feature specification.", UpsertFeatureSpecInput.shape,
      async (input) => this.callTool("upsert_feature_spec", input.id, undefined, async () => {
        const id = input.id ?? `feat-${Date.now()}`;
        const existing = await this.env.SHARED_CONTEXT.get<FeatureSpec>(KV_KEYS.featureSpec(id), "json");
        const tasks: Task[] = (input.tasks ?? existing?.tasks ?? []).map((t, i) => ({
          id: `${id}-task-${i + 1}`, title: t.title, description: t.description,
          assignedRole: t.assignedRole, status: "todo" as const,
        }));
        const spec: FeatureSpec = {
          id, title: input.title, description: input.description,
          status: input.status ?? "planning",
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks,
          assignedAgents: existing?.assignedAgents ?? {},
          githubIssue: input.githubIssue ?? existing?.githubIssue,
          githubBranch: input.githubBranch ?? existing?.githubBranch,
          githubPR: existing?.githubPR, // preserve existing PR data
        };
        spec.assignedAgents[this.session.agentRole] = this.session.agentName;
        await this.env.SHARED_CONTEXT.put(KV_KEYS.featureSpec(id), JSON.stringify(spec));
        const index = await this.env.SHARED_CONTEXT.get<string[]>(KV_KEYS.featureIndex, "json") ?? [];
        if (!index.includes(id)) { index.push(id); await this.env.SHARED_CONTEXT.put(KV_KEYS.featureIndex, JSON.stringify(index)); }
        this.session.currentFeature = id;
        await this.persistSession();
        this.broadcast({ type: "feature_updated", feature: spec, timestamp: new Date().toISOString() }).catch(() => {});
        return this.ok(`Feature '${id}' saved. Tasks: ${tasks.length}.`);
      })
    );

    this.server.tool("update_task_status", "Mark a task as in-progress, done, or blocked.", UpdateTaskStatusInput.shape,
      async ({ featureId, taskId, status, blockedBy }) => this.callTool("update_task_status", featureId, taskId, async () => {
        const spec = await this.env.SHARED_CONTEXT.get<FeatureSpec>(KV_KEYS.featureSpec(featureId), "json");
        if (!spec) return this.err(`Feature '${featureId}' not found.`);
        const task = spec.tasks.find(t => t.id === taskId);
        if (!task) return this.err(`Task '${taskId}' not found.`);
        task.status = status;
        if (blockedBy) task.blockedBy = blockedBy;
        if (status === "done") { task.completedAt = new Date().toISOString(); this.session.tasksCompleted.push(taskId); }
        spec.updatedAt = new Date().toISOString();
        await this.env.SHARED_CONTEXT.put(KV_KEYS.featureSpec(featureId), JSON.stringify(spec));
        await this.persistSession();
        this.broadcast({ type: "task_updated", featureId, taskId, status, agentRole: this.session.agentRole, agentName: this.session.agentName, timestamp: new Date().toISOString() }).catch(() => {});
        return this.ok(`Task '${task.title}' → '${status}'.`);
      })
    );

    this.server.tool("update_session_notes", "Save working notes (survives hibernation).", UpdateSessionNotesInput.shape,
      async ({ notes }) => this.callTool("update_session_notes", undefined, undefined, async () => {
        this.session.notes = notes;
        await this.persistSession();
        return this.ok("Session notes saved.");
      })
    );

    this.server.tool("read_shared_memory", "Read shared KV memory.", ReadSharedMemoryInput.shape,
      async ({ role }) => this.callTool("read_shared_memory", undefined, undefined, async () => {
        const key = role ? KV_KEYS.agentMemory(role) : KV_KEYS.sharedNotes;
        const content = await this.env.SHARED_CONTEXT.get(key);
        return this.ok(content ?? `No memory at '${key}'.`);
      })
    );

    this.server.tool("write_shared_memory", "Write to shared KV memory (visible to all agents).", WriteSharedMemoryInput.shape,
      async ({ content, role, append }) => this.callTool("write_shared_memory", undefined, undefined, async () => {
        const key = role ? KV_KEYS.agentMemory(role) : KV_KEYS.sharedNotes;
        let finalContent = content;
        if (append) { const existing = await this.env.SHARED_CONTEXT.get(key); if (existing) finalContent = `${existing}\n\n---\n\n${content}`; }
        await this.env.SHARED_CONTEXT.put(key, finalContent);
        this.broadcast({ type: "memory_written", key, role, agentName: this.session.agentName, timestamp: new Date().toISOString() }).catch(() => {});
        return this.ok(`Memory written to '${key}'.`);
      })
    );

    this.server.tool("get_session_state", "Get current session state.", GetSessionStateInput.shape,
      async () => this.callTool("get_session_state", undefined, undefined, async () =>
        this.ok(JSON.stringify(this.session, null, 2))
      )
    );

    this.server.tool("update_conventions", "Update global project conventions (planner/orchestrator only).", UpdateConventionsInput.shape,
      async ({ section, content }) => this.callTool("update_conventions", undefined, undefined, async () => {
        if (!["planner", "orchestrator"].includes(this.session.agentRole)) {
          return this.err(`Access denied. Your role: ${this.session.agentRole}`);
        }
        const conventions = await this.getConventions();
        try {
          (conventions as any)[section] = JSON.parse(content);
          conventions.lastUpdated = new Date().toISOString();
          await this.env.SHARED_CONTEXT.put(KV_KEYS.conventions, JSON.stringify(conventions));
          return this.ok(`Conventions section '${section}' updated.`);
        } catch { return this.err("Invalid JSON for conventions section."); }
      })
    );

    // ── GitHub tools ──────────────────────────────────────────────

    this.server.tool(
      "github_get_repo_info",
      "Get repository info: name, default branch, description. Good for orientation at session start.",
      GitHubGetRepoInfoInput.shape,
      async ({ repo }) => this.callTool("github_get_repo_info", undefined, undefined, async () => {
        const info = await this.gh.getRepoInfo(repo);
        return this.ok(JSON.stringify(info, null, 2));
      })
    );

    this.server.tool(
      "github_create_branch",
      "Create a new git branch in the repository. The planner agent should call this when starting a new feature.",
      GitHubCreateBranchInput.shape,
      async ({ repo, branchName, fromBranch }) => this.callTool("github_create_branch", undefined, undefined, async () => {
        const result = await this.gh.createBranch(repo, branchName, fromBranch);
        return this.ok(`Branch '${result.name}' created at ${result.sha.slice(0, 7)}.`);
      })
    );

    this.server.tool(
      "github_open_pr",
      "Open a pull request. Call this when a feature branch is ready for review. The PR is cached on the feature spec so the dashboard can display it.",
      GitHubOpenPRInput.shape,
      async ({ repo, title, body, head, base, draft, reviewers }) => this.callTool("github_open_pr", undefined, undefined, async () => {
        const pr = await this.gh.openPullRequest(repo, { title, body, head, base, draft, reviewers });

        // Cache PR on the matching feature spec (match by branch name)
        await this.cachePROnFeature(head, pr);

        this.broadcast({ type: "pr_opened", pr, agentName: this.session.agentName, timestamp: new Date().toISOString() }).catch(() => {});
        return this.ok(`PR #${pr.number} opened: ${pr.url}`);
      })
    );

    this.server.tool(
      "github_get_pr",
      "Get the current status of a pull request, including review state and merge status.",
      GitHubGetPRInput.shape,
      async ({ repo, prNumber }) => this.callTool("github_get_pr", undefined, undefined, async () => {
        const pr = await this.gh.getPullRequest(repo, prNumber);
        const reviews = await this.gh.getPRReviews(repo, prNumber);
        return this.ok(JSON.stringify({ ...pr, reviews }, null, 2));
      })
    );

    this.server.tool(
      "github_list_open_prs",
      "List open pull requests, optionally filtered by branch. Use to see what's awaiting review.",
      GitHubListOpenPRsInput.shape,
      async ({ repo, headBranch }) => this.callTool("github_list_open_prs", undefined, undefined, async () => {
        const prs = await this.gh.listOpenPRs(repo, headBranch);
        if (prs.length === 0) return this.ok("No open pull requests.");
        return this.ok(JSON.stringify(prs.map(p => ({
          number: p.number, title: p.title, url: p.url, draft: p.draft,
          author: p.author, head: p.headBranch, comments: p.comments,
        })), null, 2));
      })
    );

    this.server.tool(
      "github_add_pr_comment",
      "Post a comment on a pull request. Use for review notes, questions, or handoff messages to other agents.",
      GitHubAddPRCommentInput.shape,
      async ({ repo, prNumber, body }) => this.callTool("github_add_pr_comment", undefined, undefined, async () => {
        const result = await this.gh.addPRComment(repo, prNumber, body);
        return this.ok(`Comment posted: ${result.url}`);
      })
    );

    this.server.tool(
      "github_merge_pr",
      "Merge a pull request. Restricted to reviewer/orchestrator roles. Squash merge by default.",
      GitHubMergePRInput.shape,
      async ({ repo, prNumber, mergeMethod, commitTitle, commitMessage }) => this.callTool("github_merge_pr", undefined, undefined, async () => {
        if (!["reviewer", "orchestrator"].includes(this.session.agentRole)) {
          return this.err(`Merge restricted to reviewer/orchestrator. Your role: ${this.session.agentRole}`);
        }
        const result = await this.gh.mergePullRequest(repo, prNumber, { mergeMethod, commitTitle, commitMessage });
        this.broadcast({ type: "pr_merged", repo, prNumber, sha: result.sha, agentName: this.session.agentName, timestamp: new Date().toISOString() }).catch(() => {});
        return this.ok(`PR #${prNumber} merged. SHA: ${result.sha?.slice(0, 7)} — ${result.message}`);
      })
    );
  }

  // ── Helpers ────────────────────────────────────────────────────

  /** Cache GitHub PR data on the feature spec that matches the branch name */
  private async cachePROnFeature(branchName: string, pr: import("./types").GitHubPR): Promise<void> {
    const index = await this.env.SHARED_CONTEXT.get<string[]>(KV_KEYS.featureIndex, "json") ?? [];
    for (const id of index) {
      const spec = await this.env.SHARED_CONTEXT.get<FeatureSpec>(KV_KEYS.featureSpec(id), "json");
      if (spec?.githubBranch === branchName) {
        spec.githubPR = pr;
        spec.updatedAt = new Date().toISOString();
        await this.env.SHARED_CONTEXT.put(KV_KEYS.featureSpec(id), JSON.stringify(spec));
        this.broadcast({ type: "feature_updated", feature: spec, timestamp: new Date().toISOString() }).catch(() => {});
        break;
      }
    }
  }

  private async getConventions(): Promise<ProjectConventions> {
    const stored = await this.env.SHARED_CONTEXT.get<ProjectConventions>(KV_KEYS.conventions, "json");
    if (!stored) {
      await this.env.SHARED_CONTEXT.put(KV_KEYS.conventions, JSON.stringify(DEFAULT_CONVENTIONS));
      return DEFAULT_CONVENTIONS;
    }
    return stored;
  }

  private async persistSession(): Promise<void> {
    this.session.lastActiveAt = new Date().toISOString();
    await this.ctx.storage.put("session", this.session);
  }
}

// ── Dashboard API handler ────────────────────────────────────────
async function handleDashboardApi(url: URL, env: Env): Promise<Response> {
  const path = url.pathname.replace("/dashboard/api", "");
  if (path === "/sessions") {
    return Response.json(await env.SHARED_CONTEXT.get(KV_KEYS.sessionRegistry, "json") ?? { sessions: {} });
  }
  if (path === "/features") {
    const index = await env.SHARED_CONTEXT.get<string[]>(KV_KEYS.featureIndex, "json") ?? [];
    const features: FeatureSpec[] = [];
    for (const id of index) {
      const s = await env.SHARED_CONTEXT.get<FeatureSpec>(KV_KEYS.featureSpec(id), "json");
      if (s) features.push(s);
    }
    return Response.json(features);
  }
  if (path === "/activity") {
    const limit = parseInt(url.searchParams.get("limit") ?? "50");
    return Response.json((await env.SHARED_CONTEXT.get<object[]>(KV_KEYS.activityLog, "json") ?? []).slice(0, limit));
  }
  if (path === "/stats") {
    return Response.json(await env.SHARED_CONTEXT.get(KV_KEYS.stats, "json") ?? {});
  }
  return Response.json({ error: "Unknown endpoint" }, { status: 404 });
}

// ── Worker entry point ───────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return corsResponse(new Response(null, { status: 204 }));
    if (url.pathname === "/health") {
      return corsResponse(Response.json({ status: "ok", environment: env.ENVIRONMENT, timestamp: new Date().toISOString() }));
    }
    if (url.pathname === "/dashboard/ws") {
      const id = env.DASHBOARD_BROADCASTER.idFromName("global");
      return env.DASHBOARD_BROADCASTER.get(id).fetch(new Request("https://internal/ws", request));
    }
    if (url.pathname.startsWith("/dashboard/api")) {
      return corsResponse(await handleDashboardApi(url, env));
    }
    if (url.pathname === "/mcp" || url.pathname === "/sse") {
      const sessionParam = url.searchParams.get("session");
      const doId = sessionParam ? env.MCP_AGENT.idFromName(sessionParam) : env.MCP_AGENT.newUniqueId();
      return corsResponse(await env.MCP_AGENT.get(doId).fetch(request));
    }
    if (url.pathname === "/") {
      return corsResponse(Response.json({
        name: "agentic-mcp-server",
        endpoints: {
          mcp: "/mcp", dashboard_ws: "/dashboard/ws",
          dashboard_api: "/dashboard/api/{sessions|features|activity|stats}",
          health: "/health",
        },
      }));
    }
    return corsResponse(new Response("Not found", { status: 404 }));
  },
} satisfies ExportedHandler<Env>;

function corsResponse(response: Response): Response {
  const h = new Headers(response.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
}
