import { describe, expect, it, vi } from 'vitest'
import { destructiveConfirm } from '../../src/lib/destructiveConfirm'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('destructiveConfirm', () => {
  it('builds a confirm payload without running onConfirm', () => {
    const onConfirm = vi.fn()
    const payload = destructiveConfirm({
      title: 'Delete conversation?',
      description: 'This cannot be undone from the sidebar.',
      onConfirm,
    })
    expect(payload.title).toBe('Delete conversation?')
    expect(payload.description).toContain('cannot be undone')
    expect(payload.actionLabel).toBe('Delete')
    expect(onConfirm).not.toHaveBeenCalled()
    void payload.onConfirm()
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('rejects incomplete payloads', () => {
    expect(() => destructiveConfirm({
      title: '',
      description: 'x',
      onConfirm: () => {},
    })).toThrow(/title/)
  })
})

describe('delete surfaces require confirmation (source)', () => {
  const root = join(__dirname, '../..')

  it('App session/DM delete arms setConfirmAction before deleting', () => {
    const app = readFileSync(join(root, 'src/App.tsx'), 'utf8')
    // handleDeleteSession / handleDeleteDm must open confirm, not call delete first.
    expect(app).toMatch(/const handleDeleteSession = useCallback\(\(id: string\) => \{[\s\S]*?setConfirmAction\(/)
    expect(app).toMatch(/const handleDeleteDm = useCallback\(\(session: ChatSession\) => \{[\s\S]*?setConfirmAction\(/)
    // Must not fire deleteSession at the top of the handler without confirm.
    const sessionHandler = app.slice(
      app.indexOf('const handleDeleteSession = useCallback'),
      app.indexOf('const handleDeleteDm = useCallback'),
    )
    expect(sessionHandler).toMatch(/setConfirmAction/)
    expect(sessionHandler.indexOf('setConfirmAction')).toBeLessThan(
      sessionHandler.indexOf('deleteSession'),
    )
  })

  it('Automations, Schedules, and Gateways use two-click confirm', () => {
    const auto = readFileSync(join(root, 'src/components/windows/AutomationsWindowContent.tsx'), 'utf8')
    const schedules = readFileSync(join(root, 'src/components/windows/SchedulesWindow.tsx'), 'utf8')
    const settings = readFileSync(join(root, 'src/components/settings/SettingsDialog.tsx'), 'utf8')
    expect(auto).toMatch(/confirmDeleteId/)
    expect(auto).toMatch(/if \(confirmDeleteId !== automation\.id\)/)
    expect(schedules).toMatch(/confirmDeleteId/)
    expect(schedules).toMatch(/if \(confirmDeleteId !== schedule\.id\)/)
    expect(settings).toMatch(/confirmDeleteId/)
    expect(settings).toMatch(/if \(confirmDeleteId !== gateway\.id\)/)
  })
})
