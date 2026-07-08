import { useEffect, useState } from 'react'
import { apiAuthHeaders, apiUrl } from '../lib/backendClient'

export type WorkspaceBootstrap = {
  workspace: Record<string, unknown> | null
  agents: unknown[]
  sessions: unknown[]
  documents: unknown[]
  tasks: unknown[]
  files: unknown[]
  connections: unknown[]
  memoryFacts: unknown[]
  limits?: Record<string, number>
}

/**
 * Fetch the workspace cold-load snapshot once per workspace id.
 * Hooks that accept `seed` can paint immediately while their own fetch refreshes.
 */
export function useWorkspaceBootstrap(workspaceId: string | null) {
  const [data, setData] = useState<WorkspaceBootstrap | null>(null)
  const [loading, setLoading] = useState(Boolean(workspaceId))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!workspaceId) {
      setData(null)
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const response = await fetch(
          apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/bootstrap`),
          { headers: apiAuthHeaders() },
        )
        const payload = await response.json().catch(() => null)
        if (!response.ok) {
          throw new Error(payload?.error?.message || `Bootstrap HTTP ${response.status}`)
        }
        if (!cancelled) {
          setData((payload?.data as WorkspaceBootstrap) || null)
          setLoading(false)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Bootstrap failed')
          setData(null)
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  return { data, loading, error }
}
