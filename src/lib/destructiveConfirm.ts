/**
 * Payload for the shared destructive-confirm dialog (App AlertDialog /
 * window-local confirm). Callers must not run onConfirm until the user
 * confirms; cancel leaves data intact by never invoking onConfirm.
 */
export interface DestructiveConfirm {
  title: string
  description: string
  actionLabel?: string
  onConfirm: () => void | Promise<void>
}

export function destructiveConfirm(input: {
  title: string
  description: string
  actionLabel?: string
  onConfirm: () => void | Promise<void>
}): DestructiveConfirm {
  if (typeof input.onConfirm !== 'function') {
    throw new Error('destructiveConfirm requires onConfirm')
  }
  const title = String(input.title || '').trim()
  const description = String(input.description || '').trim()
  if (!title || !description) {
    throw new Error('destructiveConfirm requires title and description')
  }
  return {
    title,
    description,
    actionLabel: input.actionLabel?.trim() || 'Delete',
    onConfirm: input.onConfirm,
  }
}
