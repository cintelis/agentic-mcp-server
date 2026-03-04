// dashboard/src/types.ts

export type AgentRole = 'planner' | 'frontend' | 'backend' | 'tester' | 'devops' | 'reviewer' | 'orchestrator'

export interface AgentSession {
  sessionId: string
  agentRole: AgentRole
  agentName: string
  createdAt: string
  lastActiveAt: string
  currentFeature?: string
  currentTask?: string
  isActive: boolean
}

export interface Task {
  id: string
  title: string
  description: string
  assignedRole: AgentRole
  status: 'todo' | 'in-progress' | 'done' | 'blocked'
  blockedBy?: string
  completedAt?: string
}

export interface FeatureSpec {
  id: string
  title: string
  description: string
  status: 'planning' | 'in-progress' | 'review' | 'done'
  createdAt: string
  updatedAt: string
  tasks: Task[]
  assignedAgents: Partial<Record<AgentRole, string>>
  githubIssue?: number
  githubBranch?: string
  githubPR?: GitHubPR
}

export interface GitHubPR {
  number: number
  title: string
  url: string
  state: 'open' | 'closed' | 'merged'
  draft: boolean
  reviewState?: 'approved' | 'changes_requested' | 'pending'
  createdAt: string
  updatedAt: string
  author: string
  headBranch: string
  baseBranch: string
  additions: number
  deletions: number
  comments: number
  reviewers: string[]
}

export interface ActivityEvent {
  id: string
  timestamp: string
  sessionId: string
  agentRole: AgentRole
  agentName: string
  tool: string
  featureId?: string
  taskId?: string
  durationMs?: number
  success: boolean
}

export interface AgentStats {
  lastUpdated: string
  totalToolCalls: number
  toolCallCounts: Record<string, number>
  agentCallCounts: Record<string, number>
  roleCallCounts: Record<AgentRole, number>
  featureActivityCounts: Record<string, number>
  dailyCounts: Record<string, number>
  hourlyActivity: number[]
}

export interface WSEvent {
  type: 'tool_call' | 'feature_updated' | 'task_updated' | 'memory_written' | 'session_connected' | 'pr_opened' | 'pr_merged'
  timestamp: string
  [key: string]: unknown
}

// Role display config
export const ROLE_CONFIG: Record<AgentRole, { label: string; color: string; bg: string }> = {
  planner:      { label: 'Planner',      color: 'var(--accent)',  bg: 'var(--accent-dim)' },
  frontend:     { label: 'Frontend',     color: 'var(--green)',   bg: 'var(--green-dim)' },
  backend:      { label: 'Backend',      color: 'var(--purple)',  bg: 'var(--purple-dim)' },
  tester:       { label: 'Tester',       color: 'var(--yellow)',  bg: 'var(--yellow-dim)' },
  devops:       { label: 'DevOps',       color: 'var(--orange)',  bg: 'var(--orange-dim)' },
  reviewer:     { label: 'Reviewer',     color: 'var(--orange)',  bg: 'var(--orange-dim)' },
  orchestrator: { label: 'Orchestrator', color: 'var(--red)',     bg: 'var(--red-dim)' },
}

export const TOOL_ICONS: Record<string, string> = {
  get_conventions: '📋',
  get_feature_spec: '🔍',
  list_features: '📁',
  upsert_feature_spec: '✏️',
  update_task_status: '✅',
  update_session_notes: '📝',
  read_shared_memory: '📖',
  write_shared_memory: '💾',
  get_session_state: '🔄',
  update_conventions: '⚙️',
  github_get_repo_info: '🐙',
  github_create_branch: '⎇',
  github_open_pr: '🔀',
  github_get_pr: '🔍',
  github_list_open_prs: '📋',
  github_add_pr_comment: '💬',
  github_merge_pr: '✅',
}
