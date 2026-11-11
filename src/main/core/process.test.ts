import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanupWindowsNamedPipes, setProtectedCorePid } from './process'

const mocks = vi.hoisted(() => ({
  execFile: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: mocks.execFile
}))

vi.mock('../utils/dirs', () => ({
  mihomoCoreDir: () => 'C:\\Program Files\\Clash Party\\resources\\sidecar'
}))

vi.mock('../utils/logger', () => ({
  managerLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('./mihomoApi', () => ({
  getAxios: vi.fn()
}))

function isTasklist(file: string): boolean {
  return file === 'tasklist' || file.toLowerCase().endsWith('\\tasklist.exe')
}

function mockFilteredTasklist(): void {
  mocks.execFile.mockImplementation(
    (file: string, args: string[] = [], _options: unknown, callback) => {
      if (!isTasklist(file)) {
        callback(new Error(`unexpected exec: ${file}`))
        return
      }

      const filter = args.find((arg) => arg.startsWith('IMAGENAME eq '))
      if (filter === 'IMAGENAME eq mihomo.exe') {
        callback(null, {
          stdout: [
            '"mihomo.exe","1002","Console","1","20,000 K"',
            '"mihomo.exe","1003","Console","1","20,000 K"',
            '"mihomo.exe","1006","Services","0","20,000 K"'
          ].join('\r\n'),
          stderr: ''
        })
        return
      }
      if (filter === 'IMAGENAME eq mihomo-smart.exe') {
        callback(null, {
          stdout: '"mihomo-smart.exe","1004","Console","1","20,000 K"',
          stderr: ''
        })
        return
      }
      callback(Object.assign(new Error('Command failed'), { code: 1, stdout: '' }))
    }
  )
}

describe('cleanupWindowsNamedPipes', () => {
  let killSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    setProtectedCorePid(undefined)
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    mockFilteredTasklist()
  })

  afterEach(() => {
    setProtectedCorePid(undefined)
    killSpy.mockRestore()
  })

  function terminatedPids(): number[] {
    return killSpy.mock.calls
      .filter(([, signal]) => signal === 'SIGTERM')
      .map(([pid]) => pid as number)
  }

  it('does nothing on the fast path to avoid killing a freshly spawned core', async () => {
    await cleanupWindowsNamedPipes()

    expect(mocks.execFile).not.toHaveBeenCalled()
    expect(terminatedPids()).toEqual([])
  })

  it('skips the live protected core pid during thorough cleanup', async () => {
    setProtectedCorePid(1002)

    await cleanupWindowsNamedPipes(true)

    expect(terminatedPids().sort((a, b) => a - b)).toEqual([1003, 1004, 1006])
  })

  it('skips process inspection when no core executable is running', async () => {
    mocks.execFile.mockImplementation(
      (file: string, _args: string[], _options: unknown, callback) => {
        if (!isTasklist(file)) {
          callback(new Error(`unexpected exec: ${file}`))
          return
        }
        callback(Object.assign(new Error('Command failed'), { code: 1, stdout: '' }))
      }
    )

    await cleanupWindowsNamedPipes(true)

    expect(terminatedPids()).toEqual([])
  })

  it('uses PowerShell path inspection only on thorough cleanup', async () => {
    mocks.execFile.mockImplementation(
      (file: string, args: string[] = [], _options: unknown, callback) => {
        if (isTasklist(file)) {
          const filter = args.find((arg) => arg.startsWith('IMAGENAME eq '))
          if (filter === 'IMAGENAME eq mihomo.exe') {
            callback(null, {
              stdout: [
                '"mihomo.exe","1002","Console","1","20,000 K"',
                '"mihomo.exe","1003","Console","1","20,000 K"'
              ].join('\r\n'),
              stderr: ''
            })
            return
          }
          callback(Object.assign(new Error('Command failed'), { code: 1, stdout: '' }))
          return
        }

        if (file === 'powershell') {
          callback(null, {
            stdout: JSON.stringify([
              {
                Id: 1002,
                Path: 'C:\\Program Files\\Clash Party\\resources\\sidecar\\mihomo.exe'
              },
              { Id: 1003, Path: 'D:\\tools\\mihomo\\mihomo.exe' }
            ]),
            stderr: ''
          })
          return
        }

        callback(new Error(`unexpected exec: ${file}`))
      }
    )

    await cleanupWindowsNamedPipes(true)

    expect(terminatedPids()).toEqual([1002])
    const powershellArgs = mocks.execFile.mock.calls.find(([file]) => file === 'powershell')?.[1]
    expect(powershellArgs?.join(' ')).toContain('Get-Process -Id 1002,1003')
  })
})
