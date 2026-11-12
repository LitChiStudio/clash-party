import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  triggerAutoProxy: vi.fn(),
  triggerManualProxy: vi.fn(),
  showMessageBox: vi.fn(),
  isOnline: vi.fn(),
  appOnce: vi.fn(),
  getAppConfig: vi.fn()
}))

vi.mock('child_process', async (original) => ({
  ...(await original<typeof import('child_process')>()),
  execFile: mocks.execFile
}))
vi.mock('sysproxy-rs', () => ({
  triggerAutoProxy: mocks.triggerAutoProxy,
  triggerManualProxy: mocks.triggerManualProxy
}))
vi.mock('electron', () => ({
  app: { on: vi.fn(), off: vi.fn(), once: mocks.appOnce },
  dialog: { showMessageBox: mocks.showMessageBox },
  net: { isOnline: mocks.isOnline }
}))
vi.mock('i18next', () => ({ t: (key: string) => key }))
vi.mock('../config', () => ({
  getAppConfig: mocks.getAppConfig,
  getControledMihomoConfig: async () => ({ 'mixed-port': 7890 })
}))
vi.mock('../resolve/server', () => ({
  pacPort: 10000,
  startPacServer: vi.fn(),
  stopPacServer: vi.fn()
}))
vi.mock('../utils/logger', () => ({ proxyLogger: { warn: vi.fn(), error: vi.fn() } }))
vi.mock('../utils/dirs', () => ({}))

describe('Windows system proxy', () => {
  const platform = process.platform
  const key = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
  let actual: { enabled: boolean; server: string; bypass: string; pac: string; flags: number }
  let config: { sysProxy: ISysProxyConfig }

  beforeEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
    vi.useFakeTimers()
    Object.defineProperty(process, 'platform', { value: 'win32' })
    config = { sysProxy: { enable: true, mode: 'manual', bypass: ['<local>'] } }
    actual = { enabled: true, server: '127.0.0.1:7890', bypass: '<local>', pac: '', flags: 3 }
    mocks.getAppConfig.mockResolvedValue(config)
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      const connectionSettings = Buffer.alloc(12)
      connectionSettings.writeUInt32LE(actual.flags, 8)
      callback(null, {
        stdout: [
          '',
          key,
          `    ProxyEnable    REG_DWORD    0x${Number(actual.enabled)}`,
          `    ProxyServer    REG_SZ    ${actual.server}`,
          `    ProxyOverride    REG_SZ    ${actual.bypass}`,
          `    AutoConfigURL    REG_SZ    ${actual.pac}`,
          '',
          `${key}\\Connections`,
          `    DefaultConnectionSettings    REG_BINARY    ${connectionSettings.toString('hex')}`
        ].join('\r\n')
      })
    })
    mocks.triggerAutoProxy.mockImplementation((enabled: boolean, url: string) => {
      actual = { ...actual, enabled: false, pac: enabled ? url : '', flags: enabled ? 13 : 1 }
    })
    mocks.triggerManualProxy.mockImplementation(
      (enabled: boolean, host: string, port: number, bypass: string) => {
        actual = { ...actual, enabled, server: `${host}:${port}`, bypass, flags: enabled ? 3 : 1 }
      }
    )
  })

  afterEach(() => {
    mocks.appOnce.mock.calls.find(([event]) => event === 'before-quit')?.[1]()
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', { value: platform })
  })

  it('prompts once for a changed HTTPS proxy and restores only after confirmation', async () => {
    actual.server = 'http=127.0.0.1:7890;https=127.0.0.1:3333'
    mocks.showMessageBox
      .mockResolvedValueOnce({ response: 1 })
      .mockResolvedValueOnce({ response: 0 })
    const { startWindowsSystemProxyMonitor } = await import('./sysproxy')
    startWindowsSystemProxyMonitor()
    await vi.advanceTimersByTimeAsync(10000)
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)
    expect(mocks.triggerManualProxy).not.toHaveBeenCalled()

    actual.enabled = false
    await vi.advanceTimersByTimeAsync(5000)
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(2)
    expect(mocks.triggerManualProxy).toHaveBeenCalledWith(true, '127.0.0.1', 7890, '<local>')
    expect(actual).toMatchObject({ enabled: true, server: '127.0.0.1:7890', flags: 3 })
  })

  it('closes manual proxy, PAC and automatic detection while offline and ignores an old restore prompt', async () => {
    actual.pac = 'http://127.0.0.1:10000/old.pac'
    actual.flags = 13
    let respond: (response: { response: number }) => void = () => {}
    mocks.showMessageBox.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          respond = resolve
        })
    )
    mocks.isOnline.mockReturnValue(false)
    const { startWindowsSystemProxyMonitor, triggerSysProxy } = await import('./sysproxy')
    startWindowsSystemProxyMonitor()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)

    config.sysProxy.enable = false
    await triggerSysProxy(false)
    expect(actual).toMatchObject({ enabled: false, pac: '', flags: 1 })
    respond({ response: 0 })
    await vi.advanceTimersByTimeAsync(10000)
    expect(mocks.triggerManualProxy).not.toHaveBeenCalledWith(
      true,
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('reports a failed disable when Windows still has automatic detection enabled', async () => {
    actual = { ...actual, enabled: false, flags: 9 }
    mocks.triggerAutoProxy.mockImplementation(() => {})
    mocks.triggerManualProxy.mockImplementation(() => {})
    const { triggerSysProxy } = await import('./sysproxy')
    await expect(triggerSysProxy(false)).rejects.toThrow('sysproxy.disableFailed')
  })
})
