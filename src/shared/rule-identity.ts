// 用规则的稳定身份（类型 + 内容 + 目标）生成唯一 key。
// 订阅更新后规则在列表中的 index 会变化，但身份不变，因此按身份持久化开关状态，
// 重载后再把身份映射回当前 index 重新下发。
const SEP = ''

export function ruleIdentity(type: string, payload: string | undefined, proxy: string): string {
  return [type, payload ?? '', proxy].join(SEP)
}
