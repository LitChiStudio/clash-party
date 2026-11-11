import { execFile } from 'child_process'
import { promisify } from 'util'
import { readdir, rm } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { managerLogger } from '../utils/logger'
import { mihomoCoreDir } from '../utils/dirs'
import { getAxios } from './mihomoApi'

const execFilePromise = promisify(execFile)

// 常量
const CORE_READY_MAX_RETRIES = 30
const CORE_READY_RETRY_INTERVAL_MS = 100
const windowsCoreExecutables = ['mihomo.exe', 'mihomo-alpha.exe', 'mihomo-smart.exe']

// 管理器当前追踪的核心 PID。清理必须在真正 terminate 前再读一次，
// 否则「慢速枚举开始时还没有核心 → 枚举结束时新核心已起来」会把刚启动的核心误杀，
// 进而退码1→自动重启→再清理→再误杀，连接页要等很久才稳定。
let protectedCorePid: number | undefined
let cleanupChain: Promise<void> = Promise.resolve()

export function setProtectedCorePid(pid: number | undefined): void {
  protectedCorePid = typeof pid === 'number' && Number.isFinite(pid) && pid > 0 ? pid : undefined
}

export function getProtectedCorePid(): number | undefined {
  return protectedCorePid
}

export async function cleanupSocketFile(thorough = false, excludePid?: number): Promise<void> {
  if (process.platform === 'win32') {
    // Windows 命名管道随进程消失，无需删文件。常规启动也绝不能扫杀 mihomo：
    // 管道名已带随机 token，旧句柄不会挡住新核心；主动扫杀只会误伤刚拉起的实例。
    // 仅在 external controller listen 冲突（thorough=true）时才清孤儿进程。
    if (thorough) {
      await cleanupWindowsNamedPipes(true, excludePid)
    }
  } else {
    await cleanupUnixSockets()
  }
}

// 仅在外部控制器监听冲突时使用。excludePid / protectedCorePid 在 terminate 前再排除一次。
export async function cleanupWindowsNamedPipes(
  thorough = false,
  excludePid?: number
): Promise<void> {
  if (!thorough) {
    // 常规路径禁止杀进程，避免启动期误杀。
    return
  }

  const run = async (): Promise<void> => {
    try {
      const pids = await findWindowsCorePids(true, excludePid)
      if (pids.length === 0) return

      managerLogger.info(`Found potential pipe-blocking core processes: ${pids.join(',')}`)
      for (const pid of pids) {
        await terminateProcess(pid, excludePid)
      }

      await new Promise((resolve) => setTimeout(resolve, 1000))
    } catch (error) {
      managerLogger.warn('Windows named pipe cleanup failed:', error)
    }
  }

  // 串行化清理：重叠枚举是误杀新核心的主要来源。
  const waited = cleanupChain.then(run, run)
  cleanupChain = waited.then(
    () => undefined,
    () => undefined
  )
  await waited
}

async function findWindowsCorePids(thorough: boolean, excludePid?: number): Promise<number[]> {
  const timeout = thorough ? 5000 : 1500
  const candidates = await collectCorePids(timeout)
  const skipped = new Set(activeExcludePids(excludePid))
  const filtered = candidates.filter((pid) => !skipped.has(pid))
  if (filtered.length === 0) return []

  // 常规启动只按进程名清理，避免每次都拉起 PowerShell（冷启动很慢）。
  // 路径校验留给监听冲突时的 thorough 路径。
  if (!thorough) {
    return filtered
  }

  let processInfo = ''
  try {
    const result = await execFilePromise(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Process -Id ${filtered.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,Path | ConvertTo-Json -Compress`
      ],
      { windowsHide: true, timeout: timeout + 2500, maxBuffer: 4 * 1024 * 1024 }
    )
    processInfo = result.stdout.trim()
  } catch (error) {
    managerLogger.warn('Failed to inspect core process paths:', error)
    return filtered
  }
  if (!processInfo) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(processInfo)
  } catch (error) {
    managerLogger.warn('Failed to parse core process paths:', error)
    return filtered
  }

  const corePaths = windowsCoreExecutables.map((name) =>
    path.win32.resolve(mihomoCoreDir(), name).toLowerCase()
  )
  const pids: number[] = []
  const skipNow = new Set(activeExcludePids(excludePid))
  for (const proc of Array.isArray(parsed) ? parsed : [parsed]) {
    const { Id: pid, Path: exePath } = (proc ?? {}) as {
      Id?: unknown
      Path?: unknown
    }
    if (typeof pid !== 'number' || !filtered.includes(pid) || skipNow.has(pid)) continue
    if (typeof exePath !== 'string' || !exePath) {
      pids.push(pid)
    } else if (corePaths.includes(path.win32.resolve(exePath).toLowerCase())) {
      pids.push(pid)
    }
  }
  return pids
}

function activeExcludePids(excludePid?: number): number[] {
  const pids: number[] = []
  if (typeof excludePid === 'number' && Number.isFinite(excludePid)) pids.push(excludePid)
  if (typeof protectedCorePid === 'number') pids.push(protectedCorePid)
  return pids
}

// 按镜像名分别查，避免全量 tasklist（在部分环境会非 0 退出）+ 慢速 Get-CimInstance。
// tasklist /FI 在无匹配时退出码为 1，属于正常“空结果”，不能当失败。
async function collectCorePids(timeout: number): Promise<number[]> {
  const tasklistPath = getSystemTasklistPath()
  const perQueryTimeout = Math.max(500, Math.floor(timeout / windowsCoreExecutables.length))
  const results = await Promise.all(
    windowsCoreExecutables.map((name) => queryTasklistByImage(tasklistPath, name, perQueryTimeout))
  )
  const pids = new Set<number>()
  for (const list of results) {
    for (const pid of list) pids.add(pid)
  }
  return [...pids]
}

async function queryTasklistByImage(
  tasklistPath: string,
  imageName: string,
  timeout: number
): Promise<number[]> {
  try {
    const { stdout } = await execFilePromise(
      tasklistPath,
      ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'],
      {
        windowsHide: true,
        timeout,
        maxBuffer: 1024 * 1024
      }
    )
    return parseTaskListCsv(stdout, imageName)
  } catch (error) {
    const err = error as {
      code?: string | number
      stdout?: string
      message?: string
    }
    // 无匹配进程时 tasklist 常以退出码 1 结束，stdout 可能仍带 INFO 行。
    if (typeof err.stdout === 'string' && err.stdout.trim()) {
      return parseTaskListCsv(err.stdout, imageName)
    }
    if (err.code === 1 || err.code === '1') {
      return []
    }
    managerLogger.warn(`tasklist 查询 ${imageName} 失败：`, error)
    return []
  }
}

function getSystemTasklistPath(): string {
  const root = process.env.SystemRoot || 'C:\\Windows'
  return path.win32.join(root, 'System32', 'tasklist.exe')
}

function parseTaskListCsv(stdout: string, expectedImage?: string): number[] {
  const candidates: number[] = []
  const expected = expectedImage?.toLowerCase()
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^"([^"]+)","(\d+)"/)
    if (!match) continue
    const name = match[1].toLowerCase()
    if (expected) {
      if (name !== expected) continue
    } else if (!windowsCoreExecutables.includes(name)) {
      continue
    }
    const pid = parseInt(match[2], 10)
    if (!isNaN(pid) && pid !== process.pid) candidates.push(pid)
  }
  return candidates
}

async function terminateProcess(pid: number, excludePid?: number): Promise<void> {
  if (activeExcludePids(excludePid).includes(pid)) {
    managerLogger.info(`Skip terminating protected core process ${pid}`)
    return
  }

  try {
    process.kill(pid, 0)
    process.kill(pid, 'SIGTERM')
    managerLogger.info(`Terminated process ${pid} to free pipe`)
  } catch (error: unknown) {
    if ((error as { code?: string })?.code !== 'ESRCH') {
      managerLogger.warn(`Failed to terminate process ${pid}:`, error)
    }
  }
}

// Best-effort check whether a PID is still alive without actually killing it.
// process.kill(pid, 0) throws ESRCH when the process is gone and EPERM when
// it is alive but owned by another user (we treat that as "alive, don't touch").
function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    // EPERM etc: assume alive so we err on the side of NOT deleting a live socket.
    return true
  }
}

export async function cleanupUnixSockets(): Promise<void> {
  const uid = process.getuid?.() ?? 'user'

  // Legacy fixed socket paths from older releases. These never contain a PID
  // and are safe to remove unconditionally if they exist.
  const legacyPaths = [
    '/tmp/mihomo-party.sock',
    '/tmp/mihomo-party-admin.sock',
    `/tmp/mihomo-party-${uid}.sock`
  ]

  for (const socketPath of legacyPaths) {
    try {
      if (existsSync(socketPath)) {
        await rm(socketPath)
        managerLogger.info(`Cleaned up legacy socket file: ${socketPath}`)
      }
    } catch (error) {
      managerLogger.warn(`Failed to cleanup socket file ${socketPath}:`, error)
    }
  }

  // Current getMihomoIpcPath() produces /tmp/mihomo-party-<uid>-<pid>[-token].sock,
  // where <pid> is the parent Electron main-process PID. Previous versions
  // never garbage-collected these when the parent exited, so /tmp accumulates
  // one file per historical session. Sweep them now, but ONLY delete files
  // whose parent PID is no longer running to avoid nuking a sibling instance
  // (another Party window from a different user, an admin-elevated session,
  // etc.) that legitimately owns its own socket.
  const currentPrefix = `mihomo-party-${uid}-`
  try {
    const entries = await readdir('/tmp')
    for (const name of entries) {
      if (!name.startsWith(currentPrefix) || !name.endsWith('.sock')) continue
      const rest = name.slice(currentPrefix.length, -'.sock'.length)
      const pidPart = rest.split('-')[0]
      const pid = parseInt(pidPart, 10)
      if (!Number.isFinite(pid)) continue
      // Do not touch our own socket.
      if (pid === process.pid) continue
      if (isPidAlive(pid)) continue
      const socketPath = `/tmp/${name}`
      try {
        await rm(socketPath)
        managerLogger.info(`Cleaned up stale per-PID socket: ${socketPath}`)
      } catch (error) {
        managerLogger.warn(`Failed to cleanup socket file ${socketPath}:`, error)
      }
    }
  } catch (error) {
    // ENOENT on /tmp is impossible, EPERM/EACCES worth logging but not fatal.
    managerLogger.warn('Failed to enumerate /tmp for stale sockets:', error)
  }
}

export async function validateWindowsPipeAccess(pipePath: string): Promise<void> {
  try {
    managerLogger.info(`Validating pipe access for: ${pipePath}`)
    managerLogger.info(`Pipe validation completed for: ${pipePath}`)
  } catch (error) {
    managerLogger.error('Windows pipe validation failed:', error)
  }
}

export async function waitForCoreReady(): Promise<void> {
  for (let i = 0; i < CORE_READY_MAX_RETRIES; i++) {
    try {
      const axios = await getAxios(true)
      await axios.get('/')
      managerLogger.info(
        `Core ready after ${i + 1} attempts (${(i + 1) * CORE_READY_RETRY_INTERVAL_MS}ms)`
      )
      return
    } catch {
      if (i === 0) {
        managerLogger.info('Waiting for core to be ready...')
      }

      if (i === CORE_READY_MAX_RETRIES - 1) {
        throw new Error(
          `Core not ready after ${CORE_READY_MAX_RETRIES} attempts (${CORE_READY_MAX_RETRIES * CORE_READY_RETRY_INTERVAL_MS}ms)`
        )
      }

      await new Promise((resolve) => setTimeout(resolve, CORE_READY_RETRY_INTERVAL_MS))
    }
  }
}

function normalizeProcessName(name: string): string {
  return name
    .trim()
    .replace(/\.exe$/i, '')
    .toLowerCase()
}

export async function verifyProcessOwner(
  pid: number,
  expectedNames: readonly string[]
): Promise<boolean> {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }

  try {
    let processName = ''
    if (process.platform === 'win32') {
      const { stdout } = await execFilePromise(
        getSystemTasklistPath(),
        ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
        { windowsHide: true, timeout: 1000 }
      )
      const match = stdout.match(/^"([^"]+)","(\d+)"/m)
      if (!match || parseInt(match[2], 10) !== pid) return false
      processName = match[1]
    } else {
      const nameField = process.platform === 'darwin' ? 'ucomm=' : 'comm='
      const { stdout } = await execFilePromise('ps', ['-p', `${pid}`, '-o', nameField], {
        timeout: 1000
      })
      processName = stdout.trim().split(/\r?\n/, 1)[0] || ''
    }

    const normalizedName = normalizeProcessName(processName)
    return expectedNames.some((name) => normalizeProcessName(name) === normalizedName)
  } catch {
    return false
  }
}
