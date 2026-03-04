// ─────────────────────────────────────────────────────────────────
// agentic-mcp-server / src/logger.ts
// Activity logging + stats aggregation written to KV.
// Called by every tool handler to power the dashboard.
// ─────────────────────────────────────────────────────────────────

import type { ActivityEvent, AgentStats, AgentRole, SessionRegistry } from "./types";
import { KV_KEYS } from "./types";

// ── Activity logging ──────────────────────────────────────────────

export async function logActivity(
  kv: KVNamespace,
  event: Omit<ActivityEvent, "id">
): Promise<void> {
  const id = `evt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const fullEvent: ActivityEvent = { id, ...event };

  // Read current log (keep last 200 events in a single KV key)
  const existing = await kv.get<ActivityEvent[]>(KV_KEYS.activityLog, "json") ?? [];
  const updated = [fullEvent, ...existing].slice(0, 200);
  await kv.put(KV_KEYS.activityLog, JSON.stringify(updated));

  // Update stats (fire-and-forget, don't block tool response)
  updateStats(kv, fullEvent).catch(() => {});
}

// ── Stats aggregation ─────────────────────────────────────────────

async function updateStats(kv: KVNamespace, event: ActivityEvent): Promise<void> {
  const stats = await kv.get<AgentStats>(KV_KEYS.stats, "json") ?? defaultStats();

  stats.lastUpdated = new Date().toISOString();
  stats.totalToolCalls++;

  // Tool counts
  stats.toolCallCounts[event.tool] = (stats.toolCallCounts[event.tool] ?? 0) + 1;

  // Agent counts
  stats.agentCallCounts[event.agentName] = (stats.agentCallCounts[event.agentName] ?? 0) + 1;

  // Role counts
  const role = event.agentRole as AgentRole;
  stats.roleCallCounts[role] = (stats.roleCallCounts[role] ?? 0) + 1;

  // Feature counts
  if (event.featureId) {
    stats.featureActivityCounts[event.featureId] =
      (stats.featureActivityCounts[event.featureId] ?? 0) + 1;
  }

  // Daily counts
  const today = new Date().toISOString().slice(0, 10);
  stats.dailyCounts[today] = (stats.dailyCounts[today] ?? 0) + 1;

  // Hourly (sliding window — index = current hour 0-23)
  const hour = new Date().getUTCHours();
  stats.hourlyActivity[hour] = (stats.hourlyActivity[hour] ?? 0) + 1;

  await kv.put(KV_KEYS.stats, JSON.stringify(stats));
}

function defaultStats(): AgentStats {
  return {
    lastUpdated: new Date().toISOString(),
    totalToolCalls: 0,
    toolCallCounts: {},
    agentCallCounts: {},
    roleCallCounts: {
      planner: 0, frontend: 0, backend: 0,
      tester: 0, devops: 0, reviewer: 0, orchestrator: 0,
    },
    featureActivityCounts: {},
    dailyCounts: {},
    hourlyActivity: new Array(24).fill(0),
  };
}

// ── Session registry ──────────────────────────────────────────────

export async function registerSession(
  kv: KVNamespace,
  session: {
    sessionId: string;
    agentRole: AgentRole;
    agentName: string;
    createdAt: string;
    lastActiveAt: string;
    currentFeature?: string;
    currentTask?: string;
  }
): Promise<void> {
  const registry = await kv.get<SessionRegistry>(KV_KEYS.sessionRegistry, "json") ??
    { sessions: {} };

  registry.sessions[session.sessionId] = { ...session, isActive: true };

  // Prune sessions inactive for > 2 hours
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, s] of Object.entries(registry.sessions)) {
    if (new Date(s.lastActiveAt).getTime() < twoHoursAgo) {
      registry.sessions[id].isActive = false;
    }
  }

  await kv.put(KV_KEYS.sessionRegistry, JSON.stringify(registry));
}

export async function touchSession(
  kv: KVNamespace,
  sessionId: string,
  updates: Partial<{
    lastActiveAt: string;
    currentFeature: string;
    currentTask: string;
  }>
): Promise<void> {
  const registry = await kv.get<SessionRegistry>(KV_KEYS.sessionRegistry, "json");
  if (!registry?.sessions[sessionId]) return;

  Object.assign(registry.sessions[sessionId], updates, { isActive: true });
  await kv.put(KV_KEYS.sessionRegistry, JSON.stringify(registry));
}
