import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SessionState, AgentRole, FeatureSpec, Task, ProjectConventions, GitHubPR } from "./types";
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

// ── DashboardBroadcaster ─────────────────────────────────────────
export class DashboardBroadcaster {
  private connections = new Set<WebSocket>();
  constructor(private readonly doState: DurableObjectState, private readonly env: Env) {}

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
      this.doState.acceptWebSocket(server);
      this.connections.add(server);
      server.addEventListener("close", () => this.connections.delete(server));
      server.addEventListener("error", () => this.connections.delete(server));
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("Not found", { status: 404 });
  }
}

// ── AgenticMcpAgent ──────────────────────────────────────────────
export class AgenticMcpAgent extends McpAgent<Env> {
  server = new McpServer({ name: "agentic-mcp-server", version: "1.0.0" });
  private session!: SessionState;
  private gh!: GitHubClient;

  // Typed accessors — McpAgent base class exposes these as unknown without generics
  private get e(): Env { return this.env as Env; }
  private get doCtx(): DurableObjectState { return (this as unknown as { ctx: DurableObjectState }).ctx; }

  async init() {
    this.gh = new GitHubClient(this.e.GITHUB_TOKEN);

    const stored = await this.doCtx.storage.get<SessionState>("session");
    if (stored) {
      this.session = stored;
      this.session.lastActiveAt = new Date().toISOString();
    } else {
      // role and name stored in KV by main worker before this DO was called
      const doKey = this.doCtx.id.name ?? "orchestrator:unknown-agent";
      const identityJson = await this.e.SHARED_CONTEXT.get(`agent-identity:${doKey}`);
      const identity = identityJson ? JSON.parse(identityJson) as { role: string; name: string } : { role: "orchestrator", name: "unknown-agent" };
      const role = identity.role as AgentRole;
      const agentName = identity.name;
      this.session = {
        sessionId: this.doCtx.id.toString(), agentRole: role, agentName,
        createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
        tasksCompleted: [], notes: "",
      };
    }
    await this.persistSession();
    await registerSession(this.e.SHARED_CONTEXT, {
      sessionId: this.session.sessionId, agentRole: this.session.agentRole,
      agentName: this.session.agentName, createdAt: this.session.createdAt,
      lastActiveAt: this.session.lastActiveAt, currentFeature: this.session.currentFeature,
      currentTask: this.session.currentTask,
    });
    this.registerTools();
  }

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
      logActivity(this.e.SHARED_CONTEXT, evt).catch(() => {});
      this.broadcast({ type: "tool_call", ...evt }).catch(() => {});
      touchSession(this.e.SHARED_CONTEXT, this.session.sessionId, {
        lastActiveAt: new Date().toISOString(),
        ...(featureId ? { currentFeature: featureId } : {}),
        ...(taskId ? { currentTask: taskId } : {}),
      }).catch(() => {});
    }
  }

  private async broadcast(event: object): Promise<void> {
    const id = this.e.DASHBOARD_BROADCASTER.idFromName("global");
    const stub = this.e.DASHBOARD_BROADCASTER.get(id);
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

  private registerTools() {

    // get_conventions
    this.server.tool(
      "get_conventions",
      "Fetch project-wide coding conventions. Call at session start.",
      GetConventionsInput.shape,
      async (_args: z.infer<typeof GetConventionsInput>) =>
        this.callTool("get_conventions", undefined, undefined, async () => {
          const c = await this.getConventions();
          return this.ok(JSON.stringify(c, null, 2));
        })
    );

    // get_feature_spec
    this.server.tool(
      "get_feature_spec",
      "Retrieve a feature spec.",
      GetFeatureSpecInput.shape,
      async (args: z.infer<typeof GetFeatureSpecInput>) =>
        this.callTool("get_feature_spec", args.featureId, undefined, async () => {
          const spec = await this.e.SHARED_CONTEXT.get<FeatureSpec>(KV_KEYS.featureSpec(args.featureId), "json");
          if (!spec) return this.err(`Feature '${args.featureId}' not found.`);
          return this.ok(JSON.stringify(spec, null, 2));
        })
    );

    // list_features
    this.server.tool(
      "list_features",
      "List all feature specs.",
      ListFeaturesInput.shape,
      async (args: z.infer<typeof ListFeaturesInput>) =>
        this.callTool("list_features", undefined, undefined, async () => {
          const index = await this.e.SHARED_CONTEXT.get<string[]>(KV_KEYS.featureIndex, "json") ?? [];
          const features: FeatureSpec[] = [];
          for (const id of index) {
            const spec = await this.e.SHARED_CONTEXT.get<FeatureSpec>(KV_KEYS.featureSpec(id), "json");
            if (spec && (args.status === "all" || spec.status === args.status)) features.push(spec);
          }
          if (features.length === 0) return this.ok("No features found.");
          return this.ok(JSON.stringify(features.map(f => ({
            id: f.id, title: f.title, status: f.status, taskCount: f.tasks.length,
            githubBranch: f.githubBranch, githubPR: f.githubPR?.number,
          })), null, 2));
        })
    );

    // upsert_feature_spec
    this.server.tool(
      "upsert_feature_spec",
      "Create or update a feature specification.",
      UpsertFeatureSpecInput.shape,
      async (args: z.infer<typeof UpsertFeatureSpecInput>) =>
        this.callTool("upsert_feature_spec", args.id, undefined, async () => {
          const id = args.id ?? `feat-${Date.now()}`;
          const existing = await this.e.SHARED_CONTEXT.get<FeatureSpec>(KV_KEYS.featureSpec(id), "json");
          type TaskInput = { title: string; description: string; assignedRole: AgentRole };
          const tasks: Task[] = (args.tasks ?? existing?.tasks ?? []).map((t: TaskInput, i: number) => ({
            id: `${id}-task-${i + 1}`,
            title: t.title,
            description: t.description,
            assignedRole: t.assignedRole,
            status: "todo" as const,
          }));
          const spec: FeatureSpec = {
            id, title: args.title, description: args.description,
            status: args.status ?? "planning",
            createdAt: existing?.createdAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            tasks,
            assignedAgents: existing?.assignedAgents ?? {},
            githubIssue: args.githubIssue ?? existing?.githubIssue,
            githubBranch: args.githubBranch ?? existing?.githubBranch,
            githubPR: existing?.githubPR,
          };
          spec.assignedAgents[this.session.agentRole] = this.session.agentName;
          await this.e.SHARED_CONTEXT.put(KV_KEYS.featureSpec(id), JSON.stringify(spec));
          const index = await this.e.SHARED_CONTEXT.get<string[]>(KV_KEYS.featureIndex, "json") ?? [];
          if (!index.includes(id)) {
            index.push(id);
            await this.e.SHARED_CONTEXT.put(KV_KEYS.featureIndex, JSON.stringify(index));
          }
          this.session.currentFeature = id;
          await this.persistSession();
          this.broadcast({ type: "feature_updated", feature: spec, timestamp: new Date().toISOString() }).catch(() => {});
          return this.ok(`Feature '${id}' saved. Tasks: ${tasks.length}.`);
        })
    );

    // update_task_status
    this.server.tool(
      "update_task_status",
      "Mark a task as in-progress, done, or blocked.",
      UpdateTaskStatusInput.shape,
      async (args: z.infer<typeof UpdateTaskStatusInput>) =>
        this.callTool("update_task_status", args.featureId, args.taskId, async () => {
          const spec = await this.e.SHARED_CONTEXT.get<FeatureSpec>(KV_KEYS.featureSpec(args.featureId), "json");
          if (!spec) return this.err(`Feature '${args.featureId}' not found.`);
          const task = spec.tasks.find(t => t.id === args.taskId);
          if (!task) return this.err(`Task '${args.taskId}' not found.`);
          task.status = args.status;
          if (args.blockedBy) task.blockedBy = args.blockedBy;
          if (args.status === "done") {
            task.completedAt = new Date().toISOString();
            this.session.tasksCompleted.push(args.taskId);
          }
          spec.updatedAt = new Date().toISOString();
          await this.e.SHARED_CONTEXT.put(KV_KEYS.featureSpec(args.featureId), JSON.stringify(spec));
          await this.persistSession();
          this.broadcast({
            type: "task_updated", featureId: args.featureId, taskId: args.taskId,
            status: args.status, agentRole: this.session.agentRole,
            agentName: this.session.agentName, timestamp: new Date().toISOString(),
          }).catch(() => {});
          return this.ok(`Task '${task.title}' → '${args.status}'.`);
        })
    );

    // update_session_notes
    this.server.tool(
      "update_session_notes",
      "Save working notes (survives hibernation).",
      UpdateSessionNotesInput.shape,
      async (args: z.infer<typeof UpdateSessionNotesInput>) =>
        this.callTool("update_session_notes", undefined, undefined, async () => {
          this.session.notes = args.notes;
          await this.persistSession();
          return this.ok("Session notes saved.");
        })
    );

    // read_shared_memory
    this.server.tool(
      "read_shared_memory",
      "Read shared KV memory.",
      ReadSharedMemoryInput.shape,
      async (args: z.infer<typeof ReadSharedMemoryInput>) =>
        this.callTool("read_shared_memory", undefined, undefined, async () => {
          const key = args.role ? KV_KEYS.agentMemory(args.role) : KV_KEYS.sharedNotes;
          const content = await this.e.SHARED_CONTEXT.get(key);
          return this.ok(content ?? `No memory at '${key}'.`);
        })
    );

    // write_shared_memory
    this.server.tool(
      "write_shared_memory",
      "Write to shared KV memory (visible to all agents).",
      WriteSharedMemoryInput.shape,
      async (args: z.infer<typeof WriteSharedMemoryInput>) =>
        this.callTool("write_shared_memory", undefined, undefined, async () => {
          const key = args.role ? KV_KEYS.agentMemory(args.role) : KV_KEYS.sharedNotes;
          let finalContent = args.content;
          if (args.append) {
            const existing = await this.e.SHARED_CONTEXT.get(key);
            if (existing) finalContent = `${existing}\n\n---\n\n${args.content}`;
          }
          await this.e.SHARED_CONTEXT.put(key, finalContent);
          this.broadcast({
            type: "memory_written", key, role: args.role,
            agentName: this.session.agentName, timestamp: new Date().toISOString(),
          }).catch(() => {});
          return this.ok(`Memory written to '${key}'.`);
        })
    );

    // get_session_state
    this.server.tool(
      "get_session_state",
      "Get current session state.",
      GetSessionStateInput.shape,
      async (_args: z.infer<typeof GetSessionStateInput>) =>
        this.callTool("get_session_state", undefined, undefined, async () =>
          this.ok(JSON.stringify(this.session, null, 2))
        )
    );

    // update_conventions
    this.server.tool(
      "update_conventions",
      "Update global project conventions (planner/orchestrator only).",
      UpdateConventionsInput.shape,
      async (args: z.infer<typeof UpdateConventionsInput>) =>
        this.callTool("update_conventions", undefined, undefined, async () => {
          if (!["planner", "orchestrator"].includes(this.session.agentRole)) {
            return this.err(`Access denied. Your role: ${this.session.agentRole}`);
          }
          const conventions = await this.getConventions();
          try {
            (conventions as unknown as Record<string, unknown>)[args.section] = JSON.parse(args.content);
            conventions.lastUpdated = new Date().toISOString();
            await this.e.SHARED_CONTEXT.put(KV_KEYS.conventions, JSON.stringify(conventions));
            return this.ok(`Conventions section '${args.section}' updated.`);
          } catch {
            return this.err("Invalid JSON for conventions section.");
          }
        })
    );

    // github_get_repo_info
    this.server.tool(
      "github_get_repo_info",
      "Get repository info: name, default branch, description.",
      GitHubGetRepoInfoInput.shape,
      async (args: z.infer<typeof GitHubGetRepoInfoInput>) =>
        this.callTool("github_get_repo_info", undefined, undefined, async () => {
          const info = await this.gh.getRepoInfo(args.repo);
          return this.ok(JSON.stringify(info, null, 2));
        })
    );

    // github_create_branch
    this.server.tool(
      "github_create_branch",
      "Create a new git branch. The planner agent should call this when starting a new feature.",
      GitHubCreateBranchInput.shape,
      async (args: z.infer<typeof GitHubCreateBranchInput>) =>
        this.callTool("github_create_branch", undefined, undefined, async () => {
          const result = await this.gh.createBranch(args.repo, args.branchName, args.fromBranch);
          return this.ok(`Branch '${result.name}' created at ${result.sha.slice(0, 7)}.`);
        })
    );

    // github_open_pr
    this.server.tool(
      "github_open_pr",
      "Open a pull request. PR is cached on the feature spec so the dashboard can display it.",
      GitHubOpenPRInput.shape,
      async (args: z.infer<typeof GitHubOpenPRInput>) =>
        this.callTool("github_open_pr", undefined, undefined, async () => {
          const pr = await this.gh.openPullRequest(args.repo, {
            title: args.title, body: args.body, head: args.head,
            base: args.base, draft: args.draft, reviewers: args.reviewers,
          });
          await this.cachePROnFeature(args.head, pr);
          this.broadcast({ type: "pr_opened", pr, agentName: this.session.agentName, timestamp: new Date().toISOString() }).catch(() => {});
          return this.ok(`PR #${pr.number} opened: ${pr.url}`);
        })
    );

    // github_get_pr
    this.server.tool(
      "github_get_pr",
      "Get the current status of a pull request, including review state.",
      GitHubGetPRInput.shape,
      async (args: z.infer<typeof GitHubGetPRInput>) =>
        this.callTool("github_get_pr", undefined, undefined, async () => {
          const pr = await this.gh.getPullRequest(args.repo, args.prNumber);
          const reviews = await this.gh.getPRReviews(args.repo, args.prNumber);
          return this.ok(JSON.stringify({ ...pr, reviews }, null, 2));
        })
    );

    // github_list_open_prs
    this.server.tool(
      "github_list_open_prs",
      "List open pull requests, optionally filtered by branch.",
      GitHubListOpenPRsInput.shape,
      async (args: z.infer<typeof GitHubListOpenPRsInput>) =>
        this.callTool("github_list_open_prs", undefined, undefined, async () => {
          const prs = await this.gh.listOpenPRs(args.repo, args.headBranch);
          if (prs.length === 0) return this.ok("No open pull requests.");
          return this.ok(JSON.stringify(prs.map(p => ({
            number: p.number, title: p.title, url: p.url, draft: p.draft,
            author: p.author, head: p.headBranch, comments: p.comments,
          })), null, 2));
        })
    );

    // github_add_pr_comment
    this.server.tool(
      "github_add_pr_comment",
      "Post a comment on a pull request.",
      GitHubAddPRCommentInput.shape,
      async (args: z.infer<typeof GitHubAddPRCommentInput>) =>
        this.callTool("github_add_pr_comment", undefined, undefined, async () => {
          const result = await this.gh.addPRComment(args.repo, args.prNumber, args.body);
          return this.ok(`Comment posted: ${result.url}`);
        })
    );

    // github_merge_pr
    this.server.tool(
      "github_merge_pr",
      "Merge a pull request. Restricted to reviewer/orchestrator roles.",
      GitHubMergePRInput.shape,
      async (args: z.infer<typeof GitHubMergePRInput>) =>
        this.callTool("github_merge_pr", undefined, undefined, async () => {
          if (!["reviewer", "orchestrator"].includes(this.session.agentRole)) {
            return this.err(`Merge restricted to reviewer/orchestrator. Your role: ${this.session.agentRole}`);
          }
          const result = await this.gh.mergePullRequest(args.repo, args.prNumber, {
            mergeMethod: args.mergeMethod,
            commitTitle: args.commitTitle,
            commitMessage: args.commitMessage,
          });
          this.broadcast({
            type: "pr_merged", repo: args.repo, prNumber: args.prNumber,
            sha: result.sha, agentName: this.session.agentName, timestamp: new Date().toISOString(),
          }).catch(() => {});
          return this.ok(`PR #${args.prNumber} merged. SHA: ${result.sha?.slice(0, 7)} — ${result.message}`);
        })
    );
  }

  private async cachePROnFeature(branchName: string, pr: GitHubPR): Promise<void> {
    const index = await this.e.SHARED_CONTEXT.get<string[]>(KV_KEYS.featureIndex, "json") ?? [];
    for (const id of index) {
      const spec = await this.e.SHARED_CONTEXT.get<FeatureSpec>(KV_KEYS.featureSpec(id), "json");
      if (spec?.githubBranch === branchName) {
        spec.githubPR = pr;
        spec.updatedAt = new Date().toISOString();
        await this.e.SHARED_CONTEXT.put(KV_KEYS.featureSpec(id), JSON.stringify(spec));
        this.broadcast({ type: "feature_updated", feature: spec, timestamp: new Date().toISOString() }).catch(() => {});
        break;
      }
    }
  }

  private async getConventions(): Promise<ProjectConventions> {
    const stored = await this.e.SHARED_CONTEXT.get<ProjectConventions>(KV_KEYS.conventions, "json");
    if (!stored) {
      await this.e.SHARED_CONTEXT.put(KV_KEYS.conventions, JSON.stringify(DEFAULT_CONVENTIONS));
      return DEFAULT_CONVENTIONS;
    }
    return stored;
  }

  private async persistSession(): Promise<void> {
    this.session.lastActiveAt = new Date().toISOString();
    await this.doCtx.storage.put("session", this.session);
  }

}

// ── Dashboard API ────────────────────────────────────────────────
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
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
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
    if (url.pathname === "/mcp" || url.pathname === "/sse" || url.pathname.startsWith("/mcp/")) {
      const role = url.searchParams.get("role") ?? "orchestrator";
      const name = url.searchParams.get("name") ?? "unknown-agent";
      const sessionParam = url.searchParams.get("session");
      const doKey = sessionParam ?? `${role}:${name}`;
      // Store role/name in KV so init() can read them
      await env.SHARED_CONTEXT.put(`agent-identity:${doKey}`, JSON.stringify({ role, name }));
      // Use McpAgent.serve() handler which correctly handles HTTP POST for streamable-http
      const mcpHandler = AgenticMcpAgent.serve("/mcp", { binding: "MCP_AGENT" });
      // Rewrite URL to /mcp for the serve handler, preserving query params
      const serveUrl = new URL(request.url);
      serveUrl.pathname = "/mcp";
      const serveRequest = new Request(serveUrl.toString(), request);
      return corsResponse(await mcpHandler.fetch(serveRequest, env, _ctx));
    }
    if (url.pathname === "/") {
      return corsResponse(Response.json({
        name: "agentic-mcp-server",
        endpoints: { mcp: "/mcp", dashboard_ws: "/dashboard/ws", dashboard_api: "/dashboard/api/{sessions|features|activity|stats}", health: "/health" },
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
