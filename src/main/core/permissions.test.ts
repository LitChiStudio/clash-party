import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkHighPrivilegeCore } from './permissions'

const { readPipes, checkAdminPrivileges } = vi.hoisted(() => ({
  readPipes: vi.fn(),
  checkAdminPrivileges: vi.fn()
}))

vi.mock('fs', () => ({ existsSync: () => true }))
vi.mock('fs/promises', () => ({ readdir: readPipes }))
vi.mock('electron', () => ({ app: {}, dialog: {}, ipcMain: {} }))
vi.mock('../config', () => ({ getAppConfig: async () => ({ core: 'mihomo' }) }))
vi.mock('../utils/dirs', () => ({ mihomoCorePath: () => 'mihomo.exe' }))
vi.mock('../utils/logger', () => ({ managerLogger: { info: vi.fn(), error: vi.fn() } }))
vi.mock('../sys/autoRun', () => ({}))
vi.mock('../../shared/i18n', () => ({ default: {} }))
vi.mock('./admin', () => ({ checkAdminPrivileges }))

describe('checkHighPrivilegeCore', () => {
  const platform = process.platform

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(process, 'platform', { value: 'win32' })
    checkAdminPrivileges.mockResolvedValue(false)
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform })
  })

  it('does not request elevation for another application’s Mihomo', async () => {
    readPipes.mockResolvedValue(['TWProxy-d226f606', 'MihomoParty\\mihomo-user-Console-205692'])
    await expect(checkHighPrivilegeCore()).resolves.toBe(false)
  })

  it('recognizes the elevated Clash Party core’s named pipe', async () => {
    readPipes.mockResolvedValue(['MihomoParty\\mihomo-admin-litch-205692-9a7b37c3'])
    await expect(checkHighPrivilegeCore()).resolves.toBe(true)
    expect(checkAdminPrivileges).not.toHaveBeenCalled()
  })
})
