import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { ruleSwitchesPath } from '../utils/dirs'
import { logger } from '../utils/logger'
import { ruleIdentity } from '../../shared/rule-identity'
import { getAppConfig } from '../config'
import { mihomoRules, mihomoRulesDisable } from './mihomoApi'
import { getConnectionDomainTargets } from './ruleTargets'

interface ProfileRuleState {
  // 规则身份 -> 是否禁用（仅记录用户显式切换过的规则）
  states: Record<string, boolean>
  // 上一次重载时见过的规则身份集合，用于判断“新增规则”
  lastSeen: string[]
}
type Store = Record<string, ProfileRuleState>

let cache: Store | null = null

function load(): Store {
  if (cache) return cache
  try {
    const p = ruleSwitchesPath()
    if (existsSync(p)) {
      cache = JSON.parse(readFileSync(p, 'utf8')) as Store
    } else {
      cache = {}
    }
  } catch {
    cache = {}
  }
  return cache
}

function save(store: Store): void {
  cache = store
  const p = ruleSwitchesPath()
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(store), 'utf8')
}

async function currentProfileId(): Promise<string | undefined> {
  const { getProfileConfig } = await import('../config/profile')
  const { current } = await getProfileConfig()
  return current
}

// 记录一次用户手动切换（按规则身份，不依赖 index）
export async function recordRuleToggle(
  profileId: string,
  identity: string,
  disabled: boolean
): Promise<void> {
  const store = load()
  const state = store[profileId] ?? { states: {}, lastSeen: [] }
  state.states[identity] = disabled
  store[profileId] = state
  save(store)
}

// 渲染层开关点击时调用：先按 index 立刻下发（失败则抛出，由 UI 回滚），
// 成功后再按身份持久化，确保重载后能还原。
export async function mihomoRuleSetDisabled(
  identity: string,
  index: number,
  disabled: boolean
): Promise<void> {
  logger.info(
    `[ruleSwitches] setDisabled identity=${identity.slice(0, 48)} index=${index} disabled=${disabled}`
  )
  await mihomoRulesDisable({ [index]: disabled })
  const pid = (await currentProfileId()) || 'local'
  try {
    await recordRuleToggle(pid, identity, disabled)
    logger.info(`[ruleSwitches] recorded toggle pid=${pid} disabled=${disabled}`)
  } catch (e) {
    logger.warn('[ruleSwitches] 持久化规则开关失败', e)
  }
}

// 每次配置重载（订阅更新 / 手动热重载 / 内核启动）后调用：
// 按身份还原用户关掉的开关，且订阅新增的规则默认关闭。
export async function applyRuleSwitches(profileId?: string): Promise<void> {
  const current = profileId ?? (await currentProfileId())
  const pid = current || 'local'
  let info
  try {
    info = await mihomoRules()
  } catch (e) {
    logger.warn('[ruleSwitches] 读取规则失败，跳过还原', e)
    return
  }
  if (!info?.rules?.length) return

  const store = load()
  const state = store[pid] ?? { states: {}, lastSeen: [] }
  const identities = info.rules.map((r) => ruleIdentity(r.type, r.payload, r.proxy))

  // 订阅新增规则是否默认关闭。默认 true（与既有体验一致）；设为 false 则新增规则沿用订阅原意（开启）。
  let newRuleDefaultOff = true
  try {
    const cfg = await getAppConfig()
    newRuleDefaultOff = cfg.newRulesDefaultOff !== false
  } catch (e) {
    logger.warn('[ruleSwitches] 读取 newRulesDefaultOff 失败，按默认 true 处理', e)
  }

  // 首次接触该订阅：把当前运行期已禁用的规则记为关，并把现有全集记为 lastSeen，
  // 避免首次运行把所有规则都当成“新增”而全部关闭。
  if (!store[pid]) {
    for (let i = 0; i < info.rules.length; i++) {
      if (info.rules[i].extra?.disabled) state.states[identities[i]] = true
    }
    state.lastSeen = identities
    store[pid] = state
    save(store)
    logger.info(
      `[ruleSwitches] seed pid=${pid} rules=${info.rules.length} disabledSeeded=${Object.keys(state.states).length}`
    )
  }

  const patch: Record<string, boolean> = {}
  const newLastSeen: string[] = []
  const domainTargets = new Map(Object.entries(getConnectionDomainTargets(current)))
  for (let i = 0; i < info.rules.length; i++) {
    const rule = info.rules[i]
    const id = identities[i]
    newLastSeen.push(id)
    // 连接详情显式保存的前置规则始终生效，订阅中同名规则仍遵循原有开关状态。
    if (rule.type === 'Domain' && domainTargets.get(rule.payload) === rule.proxy) {
      domainTargets.delete(rule.payload)
      if (rule.extra?.disabled) patch[String(rule.index)] = false
      continue
    }
    // 用户显式切换过的规则用其记录值；未切换过的：见过(known)=开，新增(new)=按设置（默认关）
    const desired = state.states[id] ?? (state.lastSeen.includes(id) ? false : newRuleDefaultOff)
    if (desired) patch[String(rule.index)] = true
  }
  state.lastSeen = newLastSeen
  save(store)

  const keyCount = Object.keys(patch).length
  logger.info(
    `[ruleSwitches] apply pid=${pid} rules=${info.rules.length} states=${Object.keys(state.states).length} willDisable=${keyCount} indexes=${Object.keys(patch).slice(0, 30).join(',')}`
  )

  if (keyCount) {
    try {
      await mihomoRulesDisable(patch)
    } catch (e) {
      logger.warn('[ruleSwitches] 还原规则开关失败', e)
    }
  }
}
