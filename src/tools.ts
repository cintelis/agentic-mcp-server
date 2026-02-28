// ─────────────────────────────────────────────────────────────────
// agentic-mcp-server / src/tools.ts
// MCP tool definitions exposed to all connected agents.
// Each tool maps to a method on AgenticMcpAgent (index.ts).
// ─────────────────────────────────────────────────────────────────

import { z } from "zod";

// ── Tool input schemas (validated by Zod before reaching handlers) ──

export const GetConventionsInput = z.object({}).describe(
  "Fetch the project-wide coding conventions, stack patterns, and rules. " +
  "Always call this first in a new session before writing any code."
);

export const GetFeatureSpecInput = z.object({
  featureId: z.string().describe("The feature ID to retrieve"),
});

export const ListFeaturesInput = z.object({
  status: z
    .enum(["planning", "in-progress", "review", "done", "all"])
    .default("all")
    .describe("Filter features by status"),
});

export const UpsertFeatureSpecInput = z.object({
  id: z.string().optional().describe("Leave empty to create a new feature"),
  title: z.string().describe("Short feature title"),
  description: z.string().describe("Full feature description and acceptance criteria"),
  tasks: z
    .array(
      z.object({
        title: z.string(),
        description: z.string(),
        assignedRole: z.enum([
          "planner", "frontend", "backend", "tester", "reviewer", "orchestrator",
        ]),
      })
    )
    .optional()
    .describe("Task breakdown. Planner agent should populate this."),
  githubIssue: z.number().optional(),
  githubBranch: z.string().optional(),
  status: z
    .enum(["planning", "in-progress", "review", "done"])
    .optional()
    .default("planning"),
});

export const UpdateTaskStatusInput = z.object({
  featureId: z.string(),
  taskId: z.string(),
  status: z.enum(["todo", "in-progress", "done", "blocked"]),
  blockedBy: z.string().optional().describe("Task ID that is blocking this task"),
});

export const UpdateSessionNotesInput = z.object({
  notes: z.string().describe(
    "Agent's working notes for this session. Stored in Durable Object, " +
    "survives hibernation. Use to remember decisions, file paths, and progress."
  ),
});

export const ReadSharedMemoryInput = z.object({
  role: z
    .enum(["planner", "frontend", "backend", "tester", "reviewer", "orchestrator"])
    .optional()
    .describe("Read memory for a specific agent role. Omit to read shared notes."),
});

export const WriteSharedMemoryInput = z.object({
  content: z.string().describe(
    "Content to persist in shared KV memory. This is readable by ALL agents. " +
    "Use for important decisions, interfaces, or cross-agent handoff notes."
  ),
  role: z
    .enum(["planner", "frontend", "backend", "tester", "reviewer", "orchestrator"])
    .optional()
    .describe("Write to a role-specific memory slot. Omit to write to shared notes."),
  append: z.boolean().default(false).describe("Append to existing content instead of replacing"),
});

export const GetSessionStateInput = z.object({}).describe(
  "Get the current agent session state — role, active feature, completed tasks, and notes."
);

export const UpdateConventionsInput = z.object({
  section: z.enum(["cloudflare", "gcp", "github", "testing", "codeStyle"]),
  content: z.string().describe(
    "JSON string of the updated section. Must match the ProjectConventions type for that section."
  ),
}).describe(
  "Update a section of the global project conventions. " +
  "Only the orchestrator/planner role should call this."
);

// ── Tool metadata exposed in the MCP manifest ──

export const TOOL_DEFINITIONS = [
  {
    name: "get_conventions",
    description:
      "Fetch the project-wide coding conventions, stack patterns (Cloudflare Workers/Pages, " +
      "GCP Cloud Run/Firestore), git workflow, testing requirements, and code style rules. " +
      "Call this at the start of every session to stay aligned with the team's standards.",
    inputSchema: GetConventionsInput,
  },
  {
    name: "get_feature_spec",
    description:
      "Retrieve a specific feature specification including its task breakdown, assigned agents, " +
      "GitHub issue/branch, and current status. Use to understand what you're building and " +
      "what other agents are responsible for.",
    inputSchema: GetFeatureSpecInput,
  },
  {
    name: "list_features",
    description:
      "List all feature specs, optionally filtered by status. Use to get an overview of " +
      "what's in planning, in progress, or waiting for review.",
    inputSchema: ListFeaturesInput,
  },
  {
    name: "upsert_feature_spec",
    description:
      "Create or update a feature specification. The planner agent should call this after " +
      "breaking down a feature request into tasks assigned to specific agent roles. " +
      "Other agents can update status and add GitHub metadata.",
    inputSchema: UpsertFeatureSpecInput,
  },
  {
    name: "update_task_status",
    description:
      "Mark a task as in-progress, done, or blocked. Call this when you start or finish a task " +
      "so other agents and the human can track real-time progress.",
    inputSchema: UpdateTaskStatusInput,
  },
  {
    name: "update_session_notes",
    description:
      "Save working notes to your current session (Durable Object). Notes survive hibernation " +
      "and are available when you reconnect. Use to remember file paths, decisions made, " +
      "API contracts agreed on, or anything you'd put in a scratchpad.",
    inputSchema: UpdateSessionNotesInput,
  },
  {
    name: "read_shared_memory",
    description:
      "Read shared memory from KV — visible to all agents. Use to read handoff notes from " +
      "other agents, cross-agent decisions, or role-specific memory (e.g., read the frontend " +
      "agent's memory to understand the API contract it expects).",
    inputSchema: ReadSharedMemoryInput,
  },
  {
    name: "write_shared_memory",
    description:
      "Write to shared KV memory — readable by ALL agents. Use for important cross-agent " +
      "information: API contracts, schema decisions, deployment configs, or handoff summaries. " +
      "Can write to shared notes or a role-specific slot.",
    inputSchema: WriteSharedMemoryInput,
  },
  {
    name: "get_session_state",
    description:
      "Get your current session state — your agent role, active feature, tasks completed " +
      "this session, and your working notes. Good for resuming after hibernation.",
    inputSchema: GetSessionStateInput,
  },
  {
    name: "update_conventions",
    description:
      "Update a section of the global project conventions. Restricted to orchestrator/planner role. " +
      "Use when the team agrees on a new pattern or standard that all agents should follow.",
    inputSchema: UpdateConventionsInput,
  },
] as const;

// ── GitHub tool schemas ──────────────────────────────────────────

export const GitHubGetRepoInfoInput = z.object({
  repo: z.string().describe("Target repository in 'owner/repo' format, e.g. '365softlabs/my-api'"),
});

export const GitHubCreateBranchInput = z.object({
  repo: z.string().describe("Target repository in 'owner/repo' format"),
  branchName: z.string().describe("New branch name, e.g. 'feat/my-feature'"),
  fromBranch: z.string().optional().describe("Base branch to branch from. Defaults to repo default branch."),
});

export const GitHubOpenPRInput = z.object({
  repo: z.string().describe("Target repository in 'owner/repo' format"),
  title: z.string().describe("PR title"),
  body: z.string().describe("PR description (markdown supported)"),
  head: z.string().describe("Feature branch name to merge from"),
  base: z.string().optional().describe("Target branch. Defaults to repo default branch."),
  draft: z.boolean().default(false).describe("Open as a draft PR"),
  reviewers: z.array(z.string()).optional().describe("GitHub usernames to request as reviewers"),
});

export const GitHubGetPRInput = z.object({
  repo: z.string().describe("Target repository in 'owner/repo' format"),
  prNumber: z.number().int().describe("Pull request number"),
});

export const GitHubListOpenPRsInput = z.object({
  repo: z.string().describe("Target repository in 'owner/repo' format"),
  headBranch: z.string().optional().describe("Filter by head branch name"),
});

export const GitHubAddPRCommentInput = z.object({
  repo: z.string().describe("Target repository in 'owner/repo' format"),
  prNumber: z.number().int().describe("Pull request number"),
  body: z.string().describe("Comment body (markdown supported)"),
});

export const GitHubMergePRInput = z.object({
  repo: z.string().describe("Target repository in 'owner/repo' format"),
  prNumber: z.number().int().describe("Pull request number"),
  mergeMethod: z.enum(["merge", "squash", "rebase"]).default("squash"),
  commitTitle: z.string().optional().describe("Custom merge commit title"),
  commitMessage: z.string().optional().describe("Custom merge commit message"),
});
