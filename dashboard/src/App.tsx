// dashboard/src/App.tsx
import { useState, useEffect, useRef } from 'react'
import { useDashboard } from './hooks'
import { ROLE_CONFIG, TOOL_ICONS } from './types'
import type { AgentSession, FeatureSpec, ActivityEvent, AgentStats } from './types'

// ── Helpers ───────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function topN<T extends Record<string, number>>(obj: T | null | undefined, n = 5): [string, number][] {
  if (!obj) return []
  return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n)
}

function useIsMobile(maxWidth = 900) {
  const getMatch = () => typeof window !== 'undefined' && window.matchMedia(`(max-width: ${maxWidth}px)`).matches
  const [isMobile, setIsMobile] = useState(getMatch)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const media = window.matchMedia(`(max-width: ${maxWidth}px)`)
    const onChange = () => setIsMobile(media.matches)
    onChange()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [maxWidth])

  return isMobile
}

// ── Sub-components ────────────────────────────────────────────────

function RoleBadge({ role }: { role: string }) {
  const cfg = ROLE_CONFIG[role as keyof typeof ROLE_CONFIG]
  if (!cfg) return <span className="badge">{role}</span>
  return (
    <span style={{
      fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
      padding: '2px 8px', borderRadius: 3, letterSpacing: '0.08em',
      color: cfg.color, background: cfg.bg, textTransform: 'uppercase',
    }}>{cfg.label}</span>
  )
}

function StatusDot({ active }: { active: boolean }) {
  return (
    <span style={{
      display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
      background: active ? 'var(--green)' : 'var(--text-dim)',
      boxShadow: active ? '0 0 6px var(--green)' : 'none',
      animation: active ? 'pulse 2s ease infinite' : 'none',
      flexShrink: 0,
    }} />
  )
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: 'var(--bg-1)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)', padding: '16px 20px',
      ...style,
    }}>{children}</div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
      letterSpacing: '0.15em', color: 'var(--text-dim)', textTransform: 'uppercase',
      marginBottom: 12,
    }}>{children}</div>
  )
}

// ── Header ────────────────────────────────────────────────────────

function Header({ connected, activeCount, onRefresh, isMobile }: { connected: boolean; activeCount: number; onRefresh: () => void; isMobile: boolean }) {
  const [tick, setTick] = useState(0)
  useEffect(() => { const t = setInterval(() => setTick(x => x + 1), 1000); return () => clearInterval(t) }, [])
  const now = new Date().toUTCString().replace('GMT', 'UTC')

  return (
    <div style={{
      background: 'var(--bg-1)', borderBottom: '1px solid var(--border)',
      padding: isMobile ? '8px 12px' : '0 24px',
      minHeight: isMobile ? 76 : 56,
      display: 'flex',
      alignItems: 'center',
      flexWrap: isMobile ? 'wrap' : 'nowrap',
      gap: isMobile ? 10 : 20,
      flexShrink: 0,
    }}>
      {/* Logo / Title */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 28, height: 28, borderRadius: 6, background: 'var(--accent-dim)',
          border: '1px solid var(--accent)', display: 'grid', placeItems: 'center',
          fontSize: 14,
        }}>⬡</div>
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700, color: 'var(--accent)', letterSpacing: '0.05em' }}>
            MISSION CONTROL
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-dim)', letterSpacing: '0.1em' }}>
            agentic-mcp-server
          </div>
        </div>
      </div>

      <div style={{ flex: 1, minWidth: isMobile ? 0 : undefined }} />

      {/* Clock */}
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: isMobile ? 9 : 11, color: 'var(--text-dim)', ...(isMobile && { width: '100%', order: 10 }) }}>{now}</div>

      {/* Agent count */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <StatusDot active={activeCount > 0} />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: isMobile ? 10 : 11, color: 'var(--text-secondary)' }}>
          {activeCount} agent{activeCount !== 1 ? 's' : ''} active
        </span>
      </div>

      {/* WS status */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 5,
        padding: '4px 10px', borderRadius: 4,
        background: connected ? 'var(--green-dim)' : 'var(--red-dim)',
        border: `1px solid ${connected ? 'rgba(0,229,160,0.25)' : 'rgba(255,77,109,0.25)'}`,
      }}>
        <span style={{ fontSize: 8, color: connected ? 'var(--green)' : 'var(--red)', animation: connected ? 'pulse 1.5s infinite' : 'none' }}>●</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: connected ? 'var(--green)' : 'var(--red)' }}>
          {connected ? 'LIVE' : 'RECONNECTING'}
        </span>
      </div>

      {/* Refresh */}
      <button onClick={onRefresh} style={{
        background: 'var(--bg-2)', border: '1px solid var(--border-bright)',
        borderRadius: 4, padding: isMobile ? '8px 12px' : '5px 12px', color: 'var(--text-secondary)',
        minHeight: isMobile ? 36 : undefined,
        touchAction: 'manipulation',
        cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: isMobile ? 9 : 10,
        letterSpacing: '0.05em',
      }}>↺ REFRESH</button>
    </div>
  )
}

// ── Stats Bar ─────────────────────────────────────────────────────

function StatsBar({ stats, features, isMobile }: { stats: AgentStats | null; features: FeatureSpec[]; isMobile: boolean }) {
  const done = features.filter(f => f.status === 'done').length
  const inProg = features.filter(f => f.status === 'in-progress').length
  const inReview = features.filter(f => f.status === 'review').length

  const statItems = [
    { label: 'TOTAL CALLS', value: fmt(stats?.totalToolCalls ?? 0), color: 'var(--accent)' },
    { label: 'FEATURES LIVE', value: String(inProg), color: 'var(--green)' },
    { label: 'IN REVIEW', value: String(inReview), color: 'var(--yellow)' },
    { label: 'SHIPPED', value: String(done), color: 'var(--purple)' },
    { label: 'TOP AGENT', value: stats ? (topN(stats.agentCallCounts ?? {})[0]?.[0] ?? '—') : '—', color: 'var(--orange)' },
    { label: 'TOP TOOL', value: stats ? (topN(stats.toolCallCounts ?? {})[0]?.[0]?.replace(/_/g, ' ') ?? '—') : '—', color: 'var(--accent)' },
  ]

  return (
    <div style={{
      display: isMobile ? 'flex' : 'grid',
      gridTemplateColumns: isMobile ? undefined : 'repeat(6, 1fr)',
      overflowX: isMobile ? 'auto' : 'visible',
      gap: 1, background: 'var(--border)', borderBottom: '1px solid var(--border)',
      flexShrink: 0,
    }}>
      {statItems.map(({ label, value, color }) => (
        <div key={label} style={{
          background: 'var(--bg-1)', padding: isMobile ? '10px 12px' : '10px 16px',
          minWidth: isMobile ? 124 : undefined,
          display: 'flex', flexDirection: 'column', gap: 2,
        }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-dim)', letterSpacing: '0.12em' }}>{label}</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: isMobile ? 15 : 18, fontWeight: 700, color, letterSpacing: '-0.02em' }}>{value}</div>
        </div>
      ))}
    </div>
  )
}

// ── Agent Sessions Panel ─────────────────────────────────────────

function AgentsPanel({ sessions }: { sessions: Record<string, AgentSession> }) {
  const sorted = Object.values(sessions).sort((a, b) =>
    new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <SectionLabel>Agent Sessions ({sorted.length})</SectionLabel>
      {sorted.length === 0 && (
        <div style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: 11, textAlign: 'center', padding: '24px 0' }}>
          No agents connected yet
        </div>
      )}
      {sorted.map(s => (
        <div key={s.sessionId} style={{
          background: s.isActive ? 'var(--bg-2)' : 'var(--bg-1)',
          border: `1px solid ${s.isActive ? 'var(--border-bright)' : 'var(--border)'}`,
          borderLeft: `3px solid ${s.isActive ? ROLE_CONFIG[s.agentRole]?.color ?? 'var(--border)' : 'var(--border)'}`,
          borderRadius: 'var(--radius)', padding: '10px 12px',
          transition: 'all 0.2s',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <StatusDot active={s.isActive} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', flex: 1 }}>{s.agentName}</span>
            <RoleBadge role={s.agentRole} />
          </div>
          {s.currentFeature && (
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 3 }}>
              <span style={{ color: 'var(--text-dim)' }}>Feature: </span>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>{s.currentFeature}</span>
            </div>
          )}
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)' }}>
            {timeAgo(s.lastActiveAt)}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Kanban Board ──────────────────────────────────────────────────

function TaskChip({ task }: { task: FeatureSpec['tasks'][0] }) {
  const colors: Record<string, string> = { todo: 'var(--text-dim)', 'in-progress': 'var(--accent)', done: 'var(--green)', blocked: 'var(--red)' }
  const roleCfg = ROLE_CONFIG[task.assignedRole]
  return (
    <div style={{
      background: 'var(--bg-2)', border: '1px solid var(--border)',
      borderRadius: 4, padding: '6px 8px', fontSize: 11,
    }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: colors[task.status], flexShrink: 0 }} />
        <span style={{ color: 'var(--text-primary)', flex: 1, lineHeight: 1.3 }}>{task.title}</span>
      </div>
      {roleCfg && (
        <div style={{ marginTop: 4, marginLeft: 12 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: roleCfg.color, textTransform: 'uppercase' }}>{roleCfg.label}</span>
        </div>
      )}
    </div>
  )
}

function KanbanCard({ feature, isMobile }: { feature: FeatureSpec; isMobile: boolean }) {
  const [open, setOpen] = useState(false)
  const tasksByStatus = {
    todo: feature.tasks.filter(t => t.status === 'todo'),
    'in-progress': feature.tasks.filter(t => t.status === 'in-progress'),
    done: feature.tasks.filter(t => t.status === 'done'),
    blocked: feature.tasks.filter(t => t.status === 'blocked'),
  }
  const progress = feature.tasks.length > 0 ? Math.round(tasksByStatus.done.length / feature.tasks.length * 100) : 0

  return (
    <div style={{
      background: 'var(--bg-2)', border: '1px solid var(--border-bright)',
      borderRadius: 'var(--radius)', overflow: 'hidden', marginBottom: 8,
    }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          padding: isMobile ? '14px 12px' : '10px 12px',
          minHeight: isMobile ? 44 : undefined,
          cursor: 'pointer',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          touchAction: 'manipulation',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-dim)', paddingTop: 2, flexShrink: 0 }}>{feature.id}</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}>{feature.title}</span>
          <span style={{ fontSize: 10, color: 'var(--text-dim)', flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
        </div>
        {/* Progress bar */}
        <div style={{ height: 3, background: 'var(--bg-3)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${progress}%`, background: progress === 100 ? 'var(--green)' : 'var(--accent)', transition: 'width 0.4s ease', borderRadius: 2 }} />
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)' }}>{progress}% · {feature.tasks.length} tasks</span>
          {feature.githubBranch && (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--accent)', background: 'var(--accent-dim)', padding: isMobile ? '3px 7px' : '1px 5px', borderRadius: 3 }}>⎇ {feature.githubBranch}</span>
          )}
          {feature.githubPR && (
            <a
              href={feature.githubPR.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              style={{
                fontFamily: 'var(--font-mono)', fontSize: 9, padding: isMobile ? '3px 7px' : '1px 5px', borderRadius: 3, textDecoration: 'none',
                color: feature.githubPR.state === 'merged' ? 'var(--purple)' : feature.githubPR.state === 'closed' ? 'var(--red)' : feature.githubPR.draft ? 'var(--text-dim)' : 'var(--green)',
                background: feature.githubPR.state === 'merged' ? 'var(--purple-dim)' : feature.githubPR.state === 'closed' ? 'var(--red-dim)' : feature.githubPR.draft ? 'var(--bg-3)' : 'var(--green-dim)',
                border: '1px solid currentColor',
                touchAction: 'manipulation',
              }}
            >
              {feature.githubPR.state === 'merged' ? '⛙' : feature.githubPR.draft ? '⊘' : '⎇'} PR #{feature.githubPR.number}
              {feature.githubPR.reviewState === 'approved' && ' ✓'}
              {feature.githubPR.reviewState === 'changes_requested' && ' ✗'}
            </a>
          )}
        </div>
      </div>
      {open && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6, animation: 'fadeIn 0.2s ease' }}>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>{feature.description}</div>
          {feature.tasks.map(task => <TaskChip key={task.id} task={task} />)}
          {feature.tasks.length === 0 && <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>No tasks yet</span>}
        </div>
      )}
    </div>
  )
}

function KanbanBoard({ features, isMobile }: { features: FeatureSpec[]; isMobile: boolean }) {
  const columns: { key: FeatureSpec['status']; label: string; color: string }[] = [
    { key: 'planning',    label: 'Planning',    color: 'var(--text-dim)' },
    { key: 'in-progress', label: 'In Progress', color: 'var(--accent)' },
    { key: 'review',      label: 'Review',      color: 'var(--yellow)' },
    { key: 'done',        label: 'Done',        color: 'var(--green)' },
  ]

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: isMobile ? '1fr' : 'repeat(4, 1fr)',
      gap: 12,
      minHeight: 0,
    }}>
      {columns.map(col => {
        const colFeatures = features.filter(f => f.status === col.key)
        return (
          <div key={col.key} style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: col.color, flexShrink: 0 }} />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', color: col.color, textTransform: 'uppercase' }}>{col.label}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', marginLeft: 'auto' }}>{colFeatures.length}</span>
            </div>
            <div style={{ flex: 1, overflowY: isMobile ? 'visible' : 'auto' }}>
              {colFeatures.map(f => <KanbanCard key={f.id} feature={f} isMobile={isMobile} />)}
              {colFeatures.length === 0 && (
                <div style={{ border: '1px dashed var(--border)', borderRadius: 'var(--radius)', padding: '20px', textAlign: 'center', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>empty</div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Activity Feed ─────────────────────────────────────────────────

function ActivityFeed({ activity }: { activity: ActivityEvent[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const prevLen = useRef(activity.length)
  const [newIds, setNewIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (activity.length > prevLen.current) {
      const newest = activity.slice(0, activity.length - prevLen.current).map(e => e.id)
      setNewIds(new Set(newest))
      setTimeout(() => setNewIds(new Set()), 2000)
    }
    prevLen.current = activity.length
  }, [activity])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <SectionLabel>Activity Feed ({activity.length})</SectionLabel>
      <div ref={containerRef} style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {activity.map((evt, i) => {
          const roleCfg = ROLE_CONFIG[evt.agentRole]
          const isNew = newIds.has(evt.id)
          const icon = TOOL_ICONS[evt.tool] ?? '🔧'
          return (
            <div key={evt.id ?? i} style={{
              display: 'flex', gap: 8, alignItems: 'flex-start',
              padding: '6px 8px', borderRadius: 4,
              background: isNew ? 'rgba(0,212,255,0.05)' : 'transparent',
              border: `1px solid ${isNew ? 'rgba(0,212,255,0.15)' : 'transparent'}`,
              transition: 'all 0.5s ease',
              animation: isNew ? 'slideIn 0.25s ease' : undefined,
            }}>
              <span style={{ fontSize: 12, flexShrink: 0, marginTop: 1 }}>{icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: roleCfg?.color ?? 'var(--text-secondary)' }}>{evt.agentName}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>→</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)' }}>{evt.tool.replace(/_/g, ' ')}</span>
                  {evt.featureId && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--accent)', background: 'var(--accent-dim)', padding: '1px 4px', borderRadius: 3 }}>{evt.featureId}</span>}
                  {!evt.success && <span style={{ fontSize: 9, color: 'var(--red)', fontFamily: 'var(--font-mono)' }}>ERR</span>}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-dim)' }}>{timeAgo(evt.timestamp)}</span>
                  {evt.durationMs && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-dim)' }}>{evt.durationMs}ms</span>}
                </div>
              </div>
            </div>
          )
        })}
        {activity.length === 0 && (
          <div style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: 11, textAlign: 'center', paddingTop: 24 }}>
            Waiting for agent activity<span style={{ animation: 'blink 1s infinite' }}>_</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Stats Charts ──────────────────────────────────────────────────

function HourlyChart({ data }: { data: number[] | null | undefined }) {
  const safeData = data && data.length === 24 ? data : new Array(24).fill(0)
  const max = Math.max(...safeData, 1)
  const now = new Date().getUTCHours()
  return (
    <div>
      <SectionLabel>Hourly Activity (UTC)</SectionLabel>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 48 }}>
        {safeData.map((val, i) => (
          <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
            <div style={{
              width: '100%', borderRadius: '2px 2px 0 0',
              height: `${Math.max(2, (val / max) * 44)}px`,
              background: i === now ? 'var(--accent)' : 'var(--bg-3)',
              border: i === now ? '1px solid var(--accent)' : '1px solid var(--border)',
              transition: 'height 0.3s ease',
              boxShadow: i === now ? '0 0 6px var(--accent-glow)' : 'none',
            }} />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
        {[0, 6, 12, 18, 23].map(h => (
          <span key={h} style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-dim)' }}>{String(h).padStart(2, '0')}h</span>
        ))}
      </div>
    </div>
  )
}

function TopList({ title, data, color }: { title: string; data: [string, number][]; color: string }) {
  const max = data[0]?.[1] ?? 1
  return (
    <div>
      <SectionLabel>{title}</SectionLabel>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {data.map(([key, val]) => (
          <div key={key}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>{key.replace(/_/g, ' ')}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color }}>{fmt(val)}</span>
            </div>
            <div style={{ height: 3, background: 'var(--bg-3)', borderRadius: 2 }}>
              <div style={{ height: '100%', width: `${(val / max) * 100}%`, background: color, borderRadius: 2, transition: 'width 0.3s ease' }} />
            </div>
          </div>
        ))}
        {data.length === 0 && <span style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>No data yet</span>}
      </div>
    </div>
  )
}

function StatsPanel({ stats }: { stats: AgentStats | null }) {
  if (!stats) return <div style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>Loading stats…</div>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <HourlyChart data={stats.hourlyActivity} />
      <TopList title="Top Tools" data={topN(stats.toolCallCounts)} color="var(--accent)" />
      <TopList title="Top Agents" data={topN(stats.agentCallCounts)} color="var(--green)" />
      <TopList title="Top Features" data={topN(stats.featureActivityCounts)} color="var(--purple)" />
    </div>
  )
}

// ── Tab Bar ───────────────────────────────────────────────────────

type Tab = 'kanban' | 'agents' | 'activity' | 'stats'

function TabBar({ active, onChange, isMobile }: { active: Tab; onChange: (t: Tab) => void; isMobile: boolean }) {
  const tabs: { id: Tab; label: string }[] = [
    { id: 'kanban', label: '⊞ Features' },
    { id: 'agents', label: '◎ Agents' },
    { id: 'activity', label: '⚡ Activity' },
    { id: 'stats', label: '◈ Stats' },
  ]
  return (
    <div style={{
      display: 'flex',
      gap: 2,
      padding: isMobile ? '0 8px' : '0 24px',
      borderBottom: '1px solid var(--border)',
      flexShrink: 0,
      background: 'var(--bg-1)',
      overflowX: isMobile ? 'auto' : 'visible',
      WebkitOverflowScrolling: 'touch',
    }}>
      {tabs.map(t => (
        <button key={t.id} onClick={() => onChange(t.id)} style={{
          background: 'none', border: 'none', padding: isMobile ? '12px 12px' : '10px 14px',
          minHeight: isMobile ? 44 : undefined,
          fontFamily: 'var(--font-mono)', fontSize: isMobile ? 10 : 11, cursor: 'pointer',
          whiteSpace: 'nowrap',
          touchAction: 'manipulation',
          color: active === t.id ? 'var(--accent)' : 'var(--text-dim)',
          borderBottom: active === t.id ? '2px solid var(--accent)' : '2px solid transparent',
          marginBottom: -1, transition: 'color 0.15s',
        }}>{t.label}</button>
      ))}
    </div>
  )
}

// ── Main App ──────────────────────────────────────────────────────

export default function App() {
  const { sessions, features, activity, stats, connected, refresh } = useDashboard()
  const [tab, setTab] = useState<Tab>('kanban')
  const isMobile = useIsMobile()

  const activeSessions = Object.values(sessions).filter(s => s.isActive)

  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', background: 'var(--bg-0)' }}>
      <Header connected={connected} activeCount={activeSessions.length} onRefresh={refresh} isMobile={isMobile} />
      <StatsBar stats={stats} features={features} isMobile={isMobile} />
      <TabBar active={tab} onChange={setTab} isMobile={isMobile} />

      {/* Main content */}
      <div style={{ flex: 1, overflow: 'hidden', padding: isMobile ? '12px' : '20px 24px' }}>
        {tab === 'kanban' && (
          <div style={{ height: '100%', overflowY: 'auto', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', paddingBottom: isMobile ? 'max(16px, env(safe-area-inset-bottom))' : undefined }}>
            <KanbanBoard features={features} isMobile={isMobile} />
          </div>
        )}
        {tab === 'agents' && (
          <div style={{ maxWidth: isMobile ? '100%' : 480, height: '100%', overflowY: 'auto', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', paddingBottom: isMobile ? 'max(16px, env(safe-area-inset-bottom))' : undefined }}>
            <AgentsPanel sessions={sessions} />
          </div>
        )}
        {tab === 'activity' && (
          <div style={{ maxWidth: isMobile ? '100%' : 600, height: '100%', overflowY: 'auto', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', paddingBottom: isMobile ? 'max(16px, env(safe-area-inset-bottom))' : undefined }}>
            <ActivityFeed activity={activity} />
          </div>
        )}
        {tab === 'stats' && (
          <div style={{ maxWidth: isMobile ? '100%' : 420, height: '100%', overflowY: 'auto', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', paddingBottom: isMobile ? 'max(16px, env(safe-area-inset-bottom))' : undefined }}>
            <StatsPanel stats={stats} />
          </div>
        )}
      </div>
    </div>
  )
}