import { promisify } from 'util'
import { exec, execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import { triggerAutoProxy, triggerManualProxy } from 'sysproxy-rs'
import { app, dialog, net } from 'electron'
import axios from 'axios'
import { t } from 'i18next'
import { getAppConfig, getControledMihomoConfig } from '../config'
import { DEFAULT_MIHOMO_PORTS } from '../../shared/appConfig'
import { pacPort, startPacServer, stopPacServer } from '../resolve/server'
import { proxyLogger } from '../utils/logger'
import { resourcesFilesDir } from '../utils/dirs'

let triggerSysProxyTimer: NodeJS.Timeout | null = null
let triggerSysProxyQueue: Promise<void> = Promise.resolve()
let triggerSysProxySequence = 0
let pendingProxyOperations = 0
let windowsProxyMonitor: NodeJS.Timeout | undefined
let checkingWindowsProxy = false
let reportedWindowsProxyMismatch: string | undefined
const helperSocketPath = '/tmp/mihomo-party-helper.sock'
const helperPath = '/Library/PrivilegedHelperTools/party.mihomo.helper'
const helperPlistPath = '/Library/LaunchDaemons/party.mihomo.helper.plist'
const helperService = 'system/party.mihomo.helper'

const defaultBypass: string[] = (() => {
  switch (process.platform) {
    case 'linux':
      return ['localhost', '127.0.0.1', '192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12', '::1']
    case 'darwin':
      return [
        '127.0.0.1',
        '192.168.0.0/16',
        '10.0.0.0/8',
        '172.16.0.0/12',
        'localhost',
        '*.local',
        '*.crashlytics.com',
        '<local>'
      ]
    case 'win32':
      return [
        'localhost',
        '127.*',
        '192.168.*',
        '10.*',
        '172.16.*',
        '172.17.*',
        '172.18.*',
        '172.19.*',
        '172.20.*',
        '172.21.*',
        '172.22.*',
        '172.23.*',
        '172.24.*',
        '172.25.*',
        '172.26.*',
        '172.27.*',
        '172.28.*',
        '172.29.*',
        '172.30.*',
        '172.31.*',
        '<local>'
      ]
    default:
      return ['localhost', '127.0.0.1', '192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12', '::1']
  }
})()

interface TriggerSysProxyOptions {
  helperTimeout?: number
  force?: boolean
}

function helperAxiosOptions(helperTimeout?: number): { socketPath: string; timeout?: number } {
  return helperTimeout === undefined
    ? { socketPath: helperSocketPath }
    : { socketPath: helperSocketPath, timeout: helperTimeout }
}

interface ProxySettings {
  enabled: boolean
  mode: ISysProxyConfig['mode']
  host: string
  port: number
  bypass: string
  pacUrl: string
}

async function getProxySettings(): Promise<ProxySettings> {
  const { sysProxy } = await getAppConfig()
  const { 'mixed-port': port = DEFAULT_MIHOMO_PORTS.mixed } = await getControledMihomoConfig()
  const host = sysProxy.host || '127.0.0.1'
  return {
    enabled: sysProxy.enable,
    mode: sysProxy.mode,
    host,
    port,
    bypass: (sysProxy.bypass ?? defaultBypass)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .join(process.platform === 'win32' ? ';' : ','),
    pacUrl: `http://${host}:${pacPort}/pac`
  }
}

async function readWindowsProxy(): Promise<{
  manualEnabled: boolean
  manualSelected: boolean
  server: string
  bypass: string
  pac: string
  pacSelected: boolean
  autoDetect: boolean
}> {
  const key = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
  const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
  const { stdout } = await promisify(execFile)(reg, ['query', key, '/s'], {
    windowsHide: true,
    timeout: 3000
  })
  const sections = stdout.trimStart().split(/\r?\n(?=HKEY_)/i)
  const section = (name: string): string =>
    sections.find((entry) => entry.split(/\r?\n/, 1)[0].toLowerCase() === name.toLowerCase()) ?? ''
  const settings = section(key)
  if (!settings) throw new Error('Windows Internet Settings registry key was not returned')
  const connections = section(`${key}\\Connections`)
  const value = (rows: string, name: string): string =>
    rows.match(new RegExp(`^[ \\t]+${name}[ \\t]+REG_\\w+[ \\t]*([^\\r\\n]*)`, 'mi'))?.[1].trim() ??
    ''
  // WinINet stores its LAN connection flags after two DWORDs in DefaultConnectionSettings.
  const saved = Buffer.from(value(connections, 'DefaultConnectionSettings'), 'hex')
  const flags = saved.length >= 12 ? saved.readUInt32LE(8) : undefined
  const manualEnabled = Number(value(settings, 'ProxyEnable')) === 1
  const pac = value(settings, 'AutoConfigURL')
  return {
    manualEnabled,
    manualSelected: flags === undefined ? manualEnabled : Boolean(flags & 0x02),
    server: value(settings, 'ProxyServer'),
    bypass: value(settings, 'ProxyOverride'),
    pac,
    pacSelected: flags === undefined ? Boolean(pac) : Boolean(flags & 0x04),
    autoDetect: flags !== undefined && Boolean(flags & 0x08)
  }
}

function windowsProxyMatches(
  actual: Awaited<ReturnType<typeof readWindowsProxy>>,
  expected?: ProxySettings
): boolean {
  const manual = actual.manualEnabled || actual.manualSelected
  if (!expected) return !manual && !actual.pacSelected && !actual.autoDetect
  if (expected.mode === 'auto') {
    return !manual && actual.pacSelected && actual.pac === expected.pacUrl
  }

  const normalizeBypass = (bypass: string): string =>
    [
      ...new Set(
        bypass
          .toLowerCase()
          .split(';')
          .map((entry) => entry.trim())
          .filter(Boolean)
      )
    ]
      .sort()
      .join(';')
  return (
    actual.manualEnabled &&
    actual.manualSelected &&
    !actual.pacSelected &&
    !actual.autoDetect &&
    actual.server.toLowerCase() === `${expected.host}:${expected.port}`.toLowerCase() &&
    normalizeBypass(actual.bypass) === normalizeBypass(expected.bypass)
  )
}

export function startWindowsSystemProxyMonitor(): void {
  if (process.platform !== 'win32' || windowsProxyMonitor) return

  const check = (): void => {
    void checkWindowsSystemProxy()
  }
  windowsProxyMonitor = setInterval(check, 5000)
  windowsProxyMonitor.unref()
  app.on('browser-window-focus', check)
  app.once('before-quit', () => {
    clearInterval(windowsProxyMonitor)
    windowsProxyMonitor = undefined
    app.off('browser-window-focus', check)
  })
  check()
}

async function checkWindowsSystemProxy(): Promise<void> {
  if (!windowsProxyMonitor || checkingWindowsProxy || pendingProxyOperations > 0) return
  checkingWindowsProxy = true
  const sequence = triggerSysProxySequence
  try {
    const expected = await getProxySettings()
    if (!windowsProxyMonitor || sequence !== triggerSysProxySequence) return
    if (!expected.enabled) {
      reportedWindowsProxyMismatch = undefined
      return
    }

    const actual = await readWindowsProxy()
    if (!windowsProxyMonitor || sequence !== triggerSysProxySequence) return
    if (windowsProxyMatches(actual, expected)) {
      reportedWindowsProxyMismatch = undefined
      return
    }

    const mismatch = JSON.stringify([expected, actual])
    if (reportedWindowsProxyMismatch === mismatch) return
    reportedWindowsProxyMismatch = mismatch
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: t('sysproxy.title'),
      message: t('sysproxy.changed.message'),
      buttons: [t('sysproxy.changed.restore'), t('sysproxy.changed.later')],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    })

    if (response !== 0 || !(await getAppConfig()).sysProxy.enable) return
    if (!windowsProxyMonitor || sequence !== triggerSysProxySequence) return
    try {
      await triggerSysProxy(true)
    } catch (error) {
      await proxyLogger.error('Failed to restore Windows system proxy', error)
      if (windowsProxyMonitor) {
        await dialog.showMessageBox({
          type: 'error',
          message: t('common.error.sysproxySetupFailed')
        })
      }
    }
  } catch (error) {
    await proxyLogger.warn('Failed to check Windows system proxy', error)
  } finally {
    checkingWindowsProxy = false
  }
}

export async function triggerSysProxy(
  enable: boolean,
  options: TriggerSysProxyOptions = {}
): Promise<void> {
  const sequence = ++triggerSysProxySequence

  if (triggerSysProxyTimer) {
    clearTimeout(triggerSysProxyTimer)
    triggerSysProxyTimer = null
  }

  pendingProxyOperations++
  const operation = triggerSysProxyQueue
    .then(async () => {
      if (process.platform === 'win32' || net.isOnline() || options.force) {
        await disableSysProxy(options.helperTimeout)
        const expected = enable ? await enableSysProxy(options.helperTimeout) : undefined
        if (process.platform === 'win32') {
          if (!windowsProxyMatches(await readWindowsProxy(), expected)) {
            throw new Error(
              t(enable ? 'common.error.sysproxySetupFailed' : 'sysproxy.disableFailed')
            )
          }
          reportedWindowsProxyMismatch = undefined
        }
        return
      }

      if (sequence !== triggerSysProxySequence) return
      triggerSysProxyTimer = setTimeout(() => {
        triggerSysProxyTimer = null
        if (sequence !== triggerSysProxySequence) return
        void triggerSysProxy(enable, options).catch((error) => {
          void proxyLogger.error('Failed to retry system proxy', error)
        })
      }, 5000)
    })
    .finally(() => {
      pendingProxyOperations--
    })

  triggerSysProxyQueue = operation.catch(() => {})
  return operation
}

async function enableSysProxy(helperTimeout?: number): Promise<ProxySettings> {
  await startPacServer()
  const settings = await getProxySettings()
  const { mode, host, port, bypass, pacUrl } = settings

  if (process.platform === 'darwin') {
    // macOS 需要 helper 提权
    if (mode === 'auto') {
      await helperRequest(() =>
        axios.post('http://localhost/pac', { url: pacUrl }, helperAxiosOptions(helperTimeout))
      )
    } else {
      await helperRequest(() =>
        axios.post(
          'http://localhost/global',
          { host, port: port.toString(), bypass },
          helperAxiosOptions(helperTimeout)
        )
      )
    }
  } else {
    // Windows / Linux 直接使用 sysproxy-rs
    try {
      if (mode === 'auto') {
        triggerAutoProxy(true, pacUrl)
      } else {
        triggerManualProxy(true, host, port, bypass)
      }
    } catch (error) {
      await proxyLogger.error('Failed to enable system proxy', error)
      throw error
    }
  }
  return settings
}

async function disableSysProxy(helperTimeout?: number): Promise<void> {
  await stopPacServer()

  if (process.platform === 'darwin') {
    await helperRequest(
      () => axios.get('http://localhost/off', helperAxiosOptions(helperTimeout)),
      helperTimeout === undefined ? 2 : 0
    )
  } else {
    // Windows / Linux 直接使用 sysproxy-rs
    try {
      triggerAutoProxy(false, '')
      triggerManualProxy(false, '', 0, '')
    } catch (error) {
      await proxyLogger.error('Failed to disable system proxy', error)
      throw error
    }
  }
}

export function disableSysProxySync(): void {
  if (process.platform === 'darwin') return
  try {
    triggerAutoProxy(false, '')
    triggerManualProxy(false, '', 0, '')
  } catch {
    // ignore errors during sync disable
  }
}

function isSocketFileExists(): boolean {
  try {
    return fs.existsSync(helperSocketPath)
  } catch {
    return false
  }
}

async function isHelperRunning(): Promise<boolean> {
  try {
    const execPromise = promisify(exec)
    const { stdout } = await execPromise('pgrep -f party.mihomo.helper')
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

async function isHelperServiceRegistered(): Promise<boolean> {
  try {
    const execPromise = promisify(exec)
    await execPromise(`/bin/launchctl print ${helperService}`)
    return true
  } catch {
    return false
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

async function startHelperService(forceRepair = false): Promise<void> {
  const sourceHelper = shellQuote(path.join(resourcesFilesDir(), 'party.mihomo.helper'))
  const sourcePlist = shellQuote(path.join(resourcesFilesDir(), 'party.mihomo.helper.plist'))
  const installedHelper = shellQuote(helperPath)
  const installedPlist = shellQuote(helperPlistPath)
  const shell =
    `if ${forceRepair ? 'true' : 'false'} || [ ! -x ${installedHelper} ] || [ ! -f ${installedPlist} ] || ! /bin/launchctl print ${helperService} >/dev/null 2>&1; then ` +
    `[ -f ${sourceHelper} ] && [ -f ${sourcePlist} ] || exit 1; ` +
    `/bin/launchctl bootout ${helperService} >/dev/null 2>&1 || true; ` +
    `/bin/mkdir -p /Library/PrivilegedHelperTools /Library/LaunchDaemons; ` +
    `/bin/rm -f ${shellQuote(helperSocketPath)}; ` +
    `/usr/bin/install -o root -g wheel -m 544 ${sourceHelper} ${installedHelper}; ` +
    `/usr/bin/install -o root -g wheel -m 644 ${sourcePlist} ${installedPlist}; ` +
    `/bin/launchctl enable ${helperService} >/dev/null 2>&1 || true; ` +
    `/bin/launchctl bootstrap system ${installedPlist}; ` +
    `else /bin/launchctl kickstart -k ${helperService}; fi`
  const command = `do shell script ${JSON.stringify(shell)} with administrator privileges`
  const execFilePromise = promisify(execFile)
  await execFilePromise('/usr/bin/osascript', ['-e', command])
  await new Promise((resolve) => setTimeout(resolve, 1500))
}

async function requestSocketRecreation(): Promise<void> {
  try {
    const execPromise = promisify(exec)
    const shell = `pkill -USR1 -f party.mihomo.helper`
    const command = `do shell script "${shell}" with administrator privileges`
    await execPromise(`osascript -e '${command}'`)
    await new Promise((resolve) => setTimeout(resolve, 1000))
  } catch (error) {
    await proxyLogger.error('Failed to send signal to helper', error)
    throw error
  }
}

async function helperRequest(requestFn: () => Promise<unknown>, maxRetries = 2): Promise<unknown> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await requestFn()
    } catch (error) {
      lastError = error as Error
      const errCode = (error as NodeJS.ErrnoException).code
      const errMsg = (error as Error).message || ''

      if (
        attempt < maxRetries &&
        (errCode === 'ECONNREFUSED' ||
          errCode === 'ENOENT' ||
          errMsg.includes('connect ECONNREFUSED') ||
          errMsg.includes('ENOENT'))
      ) {
        await proxyLogger.info(
          `Helper request failed (attempt ${attempt + 1}/${maxRetries + 1}), checking helper status...`
        )

        const helperRunning = await isHelperRunning()
        const helperRegistered = await isHelperServiceRegistered()
        const socketExists = isSocketFileExists()

        if (!helperRunning || !helperRegistered || !fs.existsSync(helperPlistPath)) {
          await proxyLogger.info('Helper service unavailable, repairing...')
          try {
            await startHelperService(!helperRunning)
            await proxyLogger.info('Helper service started, retrying...')
            continue
          } catch (startError) {
            await proxyLogger.warn('Failed to start helper service', startError)
          }
        } else if (!socketExists) {
          await proxyLogger.info('Socket file missing but helper running, requesting recreation...')
          try {
            await requestSocketRecreation()
            await proxyLogger.info('Socket recreation requested, retrying...')
            continue
          } catch (signalError) {
            await proxyLogger.warn('Failed to request socket recreation', signalError)
          }
        } else {
          await proxyLogger.info('Helper socket is unresponsive, restarting service...')
          try {
            await startHelperService()
            await proxyLogger.info('Helper service restarted, retrying...')
            continue
          } catch (restartError) {
            await proxyLogger.warn('Failed to restart helper service', restartError)
          }
        }
      }

      if (attempt === maxRetries) {
        throw lastError
      }
    }
  }

  throw lastError
}
