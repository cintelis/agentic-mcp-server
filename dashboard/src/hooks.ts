// dashboard/src/hooks.ts
import { useState, useEffect, useRef, useCallback } from 'react'
import type { AgentSession, FeatureSpec, ActivityEvent, AgentStats, WSEvent } from './types'

const BASE = import.meta.env.VITE_API_URL ?? ''

async function fetchJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

// ── Main dashboard data hook ──────────────────────────────────────

export function useDashboard() {
  const [sessions, setSessions] = useState<Record<string, AgentSession>>({})
  const [features, setFeatures] = useState<FeatureSpec[]>([])
  const [activity, setActivity] = useState<ActivityEvent[]>([])
  const [stats, setStats] = useState<AgentStats | null>(null)
  const [connected, setConnected] = useState(false)
  const [lastEvent, setLastEvent] = useState<WSEvent | null>(null)

  // Initial load
  const load = useCallback(async () => {
    try {
      const [sessData, featData, actData, statsData] = await Promise.all([
        fetchJSON<{ sessions: Record<string, AgentSession> }>('/dashboard/api/sessions'),
        fetchJSON<FeatureSpec[]>('/dashboard/api/features'),
        fetchJSON<ActivityEvent[]>('/dashboard/api/activity?limit=100'),
        fetchJSON<AgentStats>('/dashboard/api/stats'),
      ])
      setSessions(sessData.sessions ?? {})
      setFeatures(featData)
      setActivity(actData)
      setStats(statsData)
    } catch (e) {
      console.error('Dashboard load error:', e)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // WebSocket for real-time events
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const connect = useCallback(() => {
    const wsUrl = (BASE.replace('https://', 'wss://').replace('http://', 'ws://') || `ws://${location.host}`) + '/dashboard/ws'
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => setConnected(true)
    ws.onclose = () => {
      setConnected(false)
      reconnectTimer.current = setTimeout(connect, 3000)
    }
    ws.onerror = () => ws.close()

    ws.onmessage = (e) => {
      try {
        const event: WSEvent = JSON.parse(e.data)
        setLastEvent(event)

        if (event.type === 'tool_call') {
          const ae = event as unknown as ActivityEvent
          setActivity(prev => [ae, ...prev].slice(0, 100))
          // Update session last active
          const sid = ae.sessionId
          setSessions(prev => {
            if (!prev[sid]) return prev
            return { ...prev, [sid]: { ...prev[sid], lastActiveAt: ae.timestamp, isActive: true } }
          })
        }

        if (event.type === 'feature_updated') {
          const feat = event.feature as FeatureSpec
          setFeatures(prev => {
            const idx = prev.findIndex(f => f.id === feat.id)
            if (idx >= 0) { const next = [...prev]; next[idx] = feat; return next }
            return [feat, ...prev]
          })
        }

        if (event.type === 'task_updated') {
          setFeatures(prev => prev.map(f => {
            if (f.id !== event.featureId) return f
            return { ...f, tasks: f.tasks.map(t => t.id === event.taskId ? { ...t, status: event.status as Task['status'] } : t) }
          }))
        }
      } catch {}
    }
  }, [BASE])

  useEffect(() => {
    connect()
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
    }
  }, [connect])

  // Refresh data every 30s as fallback
  useEffect(() => {
    const interval = setInterval(load, 30_000)
    return () => clearInterval(interval)
  }, [load])

  return { sessions, features, activity, stats, connected, lastEvent, refresh: load }
}

// Needed for task_updated type narrowing
type Task = { id: string; status: string }
