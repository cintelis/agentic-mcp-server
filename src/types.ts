// ─────────────────────────────────────────────────
// agentic-mcp-server / src/types.ts
// Shared types across session state, tools, and KV
// ─────────────────────────────────────────────────

/** Which agent role is connected to this session */
export type AgentRole =
  | "planner"       // Claude — spec writing, task breakdown
  | "frontend"      // Claude Code / Roo Code — Cloudflare Workers & Pages
  | "backend"       // CodeGPT (GPT-5.2-Codex) — Cloud Run & Firestore
  | "tester"        // Test generation & debug
  | "reviewer"      // PR review, security checks
  | "orchestrator"; // Coordinates other agents (human or lead agent)

/** Per-session state stored in the Durable Object's SQLite */
export interface SessionState {
  sessionId: string;
  agentRole: AgentRole;
  agentName: string;     // e.g. "claude-code", "codegpt", "roo-code"
  createdAt: string;     // ISO timestamp
  lastActiveAt: string;
  currentFeature?: string;  // Active feature branch/spec being worked on
  currentTask?: string;     // Current task within that feature
  tasksCompleted: string[]; // Task IDs finished this session
  notes: string;            // Agent's working notes — persisted across hibernation
}

/** A feature spec stored in KV — readable by all agents */
export interface FeatureSpec {
  id: string;
  title: string;
  description: string;
  status: "planning" | "in-progress" | "review" | "done";
  createdAt: string;
  updatedAt: string;
  tasks: Task[];
  assignedAgents: Partial<Record<AgentRole, string>>; // role -> agentName
  githubIssue?: number;
  githubBranch?: string;
  githubPR?: GitHubPR; // cached PR data from GitHub API
}

export interface Task {
  id: string;
  title: string;
  description: string;
  assignedRole: AgentRole;
  status: "todo" | "in-progress" | "done" | "blocked";
  blockedBy?: string; // task ID
  completedAt?: string;
}

/** Project conventions stored in KV — all agents read this */
export interface ProjectConventions {
  lastUpdated: string;
  cloudflare: {
    workerPatterns: string[];
    pagesPatterns: string[];
    kvNamingConvention: string;
    durableObjectPatterns: string[];
  };
  gcp: {
    cloudRunPatterns: string[];
    firestoreCollections: string[];
    regionDefault: string;
  };
  github: {
    branchNamingConvention: string;
    commitMessageFormat: string;
    prTemplate: string;
  };
  testing: {
    framework: string;
    minCoverage: number;
    e2ePatterns: string[];
  };
  codeStyle: {
    language: string;
    formatter: string;
    linter: string;
  };
}

/** Activity event — written to KV on every tool call */
export interface ActivityEvent {
  id: string;           // unique event ID
  timestamp: string;    // ISO
  sessionId: string;
  agentRole: AgentRole;
  agentName: string;
  tool: string;         // tool name called
  featureId?: string;   // if applicable
  taskId?: string;
  durationMs?: number;  // how long the tool call took
  success: boolean;
}

/** Aggregated stats stored in KV, updated on each tool call */
export interface AgentStats {
  lastUpdated: string;
  totalToolCalls: number;
  toolCallCounts: Record<string, number>;         // tool -> count
  agentCallCounts: Record<string, number>;        // agentName -> count
  roleCallCounts: Record<AgentRole, number>;      // role -> count
  featureActivityCounts: Record<string, number>;  // featureId -> count
  dailyCounts: Record<string, number>;            // YYYY-MM-DD -> count
  hourlyActivity: number[];                       // 24-length array, calls per hour
}

/** Registry of known sessions — updated when sessions are created/destroyed */
export interface SessionRegistry {
  sessions: Record<string, {
    sessionId: string;
    agentRole: AgentRole;
    agentName: string;
    createdAt: string;
    lastActiveAt: string;
    currentFeature?: string;
    currentTask?: string;
    isActive: boolean;
  }>;
}

/** KV key structure — used to keep key management predictable */
export const KV_KEYS = {
  conventions: "conventions:global",
  featureSpec: (id: string) => `feature:${id}`,
  featureIndex: "feature:index",
  agentMemory: (role: AgentRole) => `memory:${role}`,
  sharedNotes: "notes:shared",
  // Dashboard
  sessionRegistry: "dashboard:sessions",
  activityLog: "dashboard:activity:log",
  activityIndex: (date: string) => `dashboard:activity:${date}`, // per-day index
  stats: "dashboard:stats",
} as const;

/** GitHub PR info cached in KV alongside feature spec */
export interface GitHubPR {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  reviewState?: "approved" | "changes_requested" | "pending";
  createdAt: string;
  updatedAt: string;
  author: string;
  headBranch: string;
  baseBranch: string;
  additions: number;
  deletions: number;
  comments: number;
  reviewers: string[];
}
