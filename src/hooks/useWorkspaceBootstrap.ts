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

type WorkspaceBootstrapState = {
  workspaceId: string | null
  data: WorkspaceBootstrap | null
  loading: boolean
  error: string | null
}

/**
 * Fetch the workspace cold-load snapshot once per workspace id.
 * Hooks that accept `seed` can paint immediately while their own fetch refreshes.
 */
export function useWorkspaceBootstrap(workspaceId: string | null) {
  const [state, setState] = useState<WorkspaceBootstrapState>(() => ({
    workspaceId,
    data: null,
    loading: Boolean(workspaceId),
    error: null,
  }))

  useEffect(() => {
    if (!workspaceId) {
      setState({ workspaceId: null, data: null, loading: false, error: null })
      return
    }
    let cancelled = false
    setState({ workspaceId, data: null, loading: true, error: null })
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
        const data = (payload?.data as WorkspaceBootstrap) || null
        if (data && String(data.workspace?.id || '') !== workspaceId) {
          throw new Error('Bootstrap workspace mismatch')
        }
        if (!cancelled) {
          setState({ workspaceId, data, loading: false, error: null })
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            workspaceId,
            data: null,
            loading: false,
            error: err instanceof Error ? err.message : 'Bootstrap failed',
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  if (state.workspaceId === workspaceId) {
    return { data: state.data, loading: state.loading, error: state.error }
  }
  return { data: null, loading: Boolean(workspaceId), error: null }
}
