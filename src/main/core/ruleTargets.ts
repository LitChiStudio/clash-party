import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { ruleTargetsPath } from '../utils/dirs'
import { logger } from '../utils/logger'

// 固定代理组名：与 override 中 proxy-groups+ 追加的分组名保持一致。
// 渲染层用它把该分组置顶；修改分组名时需同步此处。
export const FIXED_GROUP_NAME = '本机固定组'

// 规则目标自定义：按 (type, payload) 记录用户希望的出站目标代理名。
// 与 ruleSwitches 不同，这里不依赖 index，也不依赖原 proxy，仅以 (type, payload) 作为键。
interface ProfileRuleTargets {
  // (type + SEP + payload) -> 目标代理名（分组名 / DIRECT / REJECT 等）
  targets: Record<string, string>
}
type Store = Record<string, ProfileRuleTargets>

const SEP = ''

let cache: Store | null = null

function load(): Store {
  if (cache) return cache
  try {
    const p = ruleTargetsPath()
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
  const p = ruleTargetsPath()
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(store), 'utf8')
}

function keyOf(type: string, payload: string | undefined): string {
  return `${type}${SEP}${payload ?? ''}`
}

async function currentProfileId(): Promise<string> {
  const { getProfileConfig } = await import('../config/profile')
  const { current } = await getProfileConfig()
  return current || 'local'
}

// mihomo REST API 返回的规则类型是「展示型」（如 RuleSet / DomainSuffix），
// 而配置文件语法要求规范形式（RULE-SET / DOMAIN-SUFFIX，全大写带连字符）。
// 注入规则时必须用规范形式，否则内核配置校验会报 unsupported rule type。
const RULE_TYPE_MAP: Record<string, string> = {
  RuleSet: 'RULE-SET',
  Domain: 'DOMAIN',
  DomainSuffix: 'DOMAIN-SUFFIX',
  DomainKeyword: 'DOMAIN-KEYWORD',
  DomainFull: 'DOMAIN-FULL',
  IpCidr: 'IP-CIDR',
  SrcIpCidr: 'SRC-IP-CIDR',
  SrcPort: 'SRC-PORT',
  DstPort: 'DST-PORT',
  ProcessName: 'PROCESS-NAME',
  ProcessPath: 'PROCESS-PATH',
  GeoIp: 'GEOIP',
  GeoSite: 'GEOSITE',
  SubRule: 'SUB-RULE',
  Script: 'SCRIPT',
  Match: 'MATCH'
}

// 把任意形式（展示型 / 规范型）的规则类型归一为规范配置类型。
// 已是全大写（含连字符）的直接返回，避免误改；否则查表或兜底为大写。
function canonicalRuleType(t: string): string {
  if (!t) return t
  if (t === t.toUpperCase()) return t
  return RULE_TYPE_MAP[t] ?? t.toUpperCase().replace(/ /g, '-')
}

// 在生成最终配置时调用：把用户自定义的目标作为具体规则前置注入到 rules 最前。
// 前置注入使其优先级最高（clash 规则引擎首条匹配即生效），从而覆盖同 payload 的订阅规则。
// 运行时规则页会按 type+payload 去重并保留优先级最高（index 最小）的条目，避免界面重复显示。
export async function applyRuleTargets(
  profile: IMihomoConfig,
  profileId?: string
): Promise<IMihomoConfig> {
  const pid = profileId || 'default'
  const store = load()
  const pidStore = store[pid]
  if (!pidStore || !pidStore.targets || Object.keys(pidStore.targets).length === 0) {
    return profile
  }
  const targets = pidStore.targets
  const rules = (profile as unknown as Record<string, unknown>).rules
  if (!Array.isArray(rules)) return profile

  const ruleStrs = rules as string[]

  const injected = Object.entries(targets).map(([key, target]) => {
    const idx = key.indexOf(SEP)
    const apiType = key.slice(0, idx)
    const payload = key.slice(idx + SEP.length)
    if (!payload) {
      // 无 payload 的规则（极少见）：直接用规范类型 + 目标兜底
      return `${canonicalRuleType(apiType)},${target}`
    }
    // 在订阅原始规则里按 payload 命中，复用其原生规范类型，只把第 3 字段（出站组）替换成用户目标。
    // 这样对所有规则类型都正确，且保留末尾选项（如 IP-CIDR 的 no-resolve）。
    const original = ruleStrs.find((r) => {
      const parts = String(r).split(',')
      const rulePayload = parts[1] ?? parts[0]
      return rulePayload === payload && canonicalRuleType(parts[0]) === canonicalRuleType(apiType)
    })
    if (original) {
      const parts = String(original).split(',')
      if (parts.length >= 3) {
        parts[2] = target
        return parts.join(',')
      }
      return `${parts[0]},${target}`
    }
    // 找不到原始规则（极端情况）用规范类型兜底
    return `${canonicalRuleType(apiType)},${payload},${target}`
  })

  ;(profile as unknown as Record<string, unknown>).rules = injected.concat(ruleStrs)
  logger.info(`[ruleTargets] 前置注入 ${injected.length} 条自定义出站规则 (pid=${pid})`)
  return profile
}

// 渲染层下拉点击后调用：记录/清除自定义目标，并触发配置重生使其生效。
export async function mihomoRuleSetTarget(
  type: string,
  payload: string | undefined,
  target: string
): Promise<void> {
  const pid = await currentProfileId()
  const store = load()
  const pidStore = store[pid] ?? { targets: {} }
  const key = keyOf(type, payload)
  if (!target || target === '__DEFAULT__') {
    delete pidStore.targets[key]
    logger.info(`[ruleTargets] 清除自定义目标 type=${type} payload=${payload ?? ''} pid=${pid}`)
  } else {
    pidStore.targets[key] = target
    logger.info(
      `[ruleTargets] 设置自定义目标 type=${type} payload=${payload ?? ''} -> ${target} pid=${pid}`
    )
  }
  store[pid] = pidStore
  save(store)

  // 配置生成层注入，必须重生配置才能让内核加载（mihomo 运行时无改规则目标 API）。
  const { mihomoHotReloadConfig } = await import('./mihomoApi')
  await mihomoHotReloadConfig()
}

// 渲染层下拉框读取已存盘的目标：作为下拉显示的唯一真相源，避免依赖父组件重渲染。
export async function getRuleTarget(
  type: string,
  payload: string | undefined
): Promise<string | undefined> {
  const pid = await currentProfileId()
  const store = load()
  const pidStore = store[pid]
  if (!pidStore || !pidStore.targets) return undefined
  return pidStore.targets[keyOf(type, payload)]
}
