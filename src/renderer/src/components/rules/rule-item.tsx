import { Button, Card, CardBody, Chip, Select, SelectItem, Switch } from '@heroui/react'
import { MdEdit } from 'react-icons/md'
import React, { useState, useEffect, useMemo } from 'react'
import {
  mihomoRuleSetDisabled,
  mihomoRuleSetTarget,
  mihomoRuleGetTarget,
  mihomoProxies
} from '@renderer/utils/ipc'
import { ruleIdentity } from '../../../../shared/rule-identity'
import { useTranslation } from 'react-i18next'
import useSWR from 'swr'
import DeleteResourceButton from '../local/delete-resource-button'

// 固定代理组名：与 override 中追加的分组名保持一致（修改分组名时需同步此处）。
const FIXED_GROUP_NAME = '本机固定组'

// 出站目标下拉：候选为内核所有代理/分组名（含订阅分组与「本机固定组」）。
// 显示值以磁盘 rule-targets.json 为唯一真相源（useSWR 读回），不再依赖父组件 current，
// 避免受控 Select 在异步写入期间因父级未刷新而回弹到订阅原目标。
const ProxyTargetSelect: React.FC<{ type: string; payload: string; current: string }> = ({
  type,
  payload,
  current
}) => {
  const { data } = useSWR('mihomoProxies', mihomoProxies)
  const savedKey = `ruleTarget:${type}:${payload}`
  const { data: saved, mutate: mutateSaved } = useSWR<string | undefined>(
    savedKey,
    () => mihomoRuleGetTarget(type, payload),
    { revalidateOnFocus: false }
  )
  const [local, setLocal] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)

  const proxies = useMemo(() => (data ? Object.keys(data.proxies) : []), [data])

  // 排序：固定组置顶（用户要求），其次默认（订阅），其余代理/分组按内核返回顺序。
  const items = useMemo(() => {
    const others = proxies.filter((p) => p !== FIXED_GROUP_NAME)
    const top = proxies.includes(FIXED_GROUP_NAME) ? [FIXED_GROUP_NAME] : []
    return [
      ...top.map((p) => ({ key: p, name: p })),
      { key: '__DEFAULT__', name: '默认（订阅）' },
      ...others.map((p) => ({ key: p, name: p }))
    ]
  }, [proxies])

  // 当前选中：本地乐观值 > 已存盘值 > 父级 current > 默认
  const selected = local ?? saved ?? (current || '__DEFAULT__')

  const onChange = async (val: string): Promise<void> => {
    if (!val || val === selected) return
    setLocal(val)
    setPending(true)
    try {
      await mihomoRuleSetTarget(type, payload, val)
      await mutateSaved()
    } catch (error) {
      console.error('Failed to set rule target:', error)
      setLocal(undefined) // 失败回滚到存盘值
    } finally {
      setPending(false)
    }
  }

  return (
    <Select
      size="sm"
      variant="flat"
      selectedKeys={new Set([selected])}
      onSelectionChange={(keys) => {
        const v = Array.from(keys as Set<string>)[0]
        if (v) void onChange(v)
      }}
      isLoading={pending}
      disableSelectorIconRotation
      aria-label="出站目标"
      className="w-40 min-w-32 shrink-0"
      classNames={{ trigger: 'min-h-7 h-7' }}
      items={items}
    >
      {(item) => <SelectItem key={item.key}>{item.name}</SelectItem>}
    </Select>
  )
}

interface RuleItemProps extends IMihomoRulesDetail {
  index: number
  onEdit?: () => void
  onDelete?: () => Promise<void>
}

const RuleItem: React.FC<RuleItemProps> = (props) => {
  const { t } = useTranslation()
  const { type, payload, proxy, index: listIndex, extra, onEdit, onDelete } = props
  const ruleIndex = props.index ?? listIndex

  const [isEnabled, setIsEnabled] = useState(!extra?.disabled)

  useEffect(() => {
    setIsEnabled(!extra?.disabled)
  }, [extra?.disabled])

  const handleToggle = async (v: boolean): Promise<void> => {
    setIsEnabled(v)
    try {
      await mihomoRuleSetDisabled(ruleIdentity(type, payload, proxy), ruleIndex, !v)
    } catch (error) {
      console.error('Failed to toggle rule:', error)
      setIsEnabled(!v)
    }
  }

  const formatRelativeTime = (timestamp: string): string => {
    const time = new Date(timestamp).getTime()
    if (time === 0) return t('rules.hitAt.never')
    const now = Date.now()
    const diff = Math.floor((now - time) / 1000)
    if (diff < 60) return t('rules.hitAt.seconds')
    if (diff < 3600) return t('rules.hitAt.minutes', { count: Math.floor(diff / 60) })
    if (diff < 86400) return t('rules.hitAt.hours', { count: Math.floor(diff / 3600) })
    return t('rules.hitAt.days', { count: Math.floor(diff / 86400) })
  }

  return (
    <div className={`w-full px-2 pb-2 ${listIndex === 0 ? 'pt-2' : ''}`}>
      <Card
        as="div"
        fullWidth
        isPressable={!!onEdit}
        onPress={onEdit}
        className={!onEdit && !isEnabled ? 'opacity-50' : ''}
      >
        <CardBody className="py-3 px-4">
          <div className="flex justify-between items-center gap-4">
            {/* 左侧：规则信息 */}
            <div className="flex-1 min-w-0 flex items-center gap-3">
              {/* 规则内容 */}
              <div className="flex-1 min-w-0">
                <div title={payload} className="text-sm font-medium truncate mb-1.5">
                  {payload}
                </div>
                <div className="flex items-center gap-2">
                  <Chip size="sm" radius="sm" variant="bordered" className="text-xs">
                    {type}
                  </Chip>
                  <Chip size="sm" radius="sm" variant="bordered" className="text-xs">
                    {proxy}
                  </Chip>
                </div>
              </div>
            </div>

            {onEdit && (
              <div
                onPointerDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
              >
                <Button
                  size="sm"
                  isIconOnly
                  variant="light"
                  title="编辑规则"
                  aria-label={`编辑规则 ${listIndex + 1}`}
                  onPress={onEdit}
                >
                  <MdEdit className="text-lg text-foreground-500" />
                </Button>
              </div>
            )}
            {onDelete && (
              <DeleteResourceButton label={`规则 ${listIndex + 1}`} onDelete={onDelete} />
            )}
            {!onEdit &&
              extra &&
              (() => {
                const total = extra.hitCount + extra.missCount
                const rate = total > 0 ? (extra.hitCount / total) * 100 : 0
                return (
                  <>
                    <div className="flex items-center gap-3 text-xs shrink-0">
                      <span className="text-foreground-500 whitespace-nowrap">
                        {formatRelativeTime(extra.hitAt || extra.missAt)}
                      </span>
                      <span className="text-foreground-600 font-medium whitespace-nowrap">
                        {extra.hitCount}/{total}
                      </span>
                      <Chip size="sm" variant="flat" color="primary" className="text-xs">
                        {rate.toFixed(1)}%
                      </Chip>
                      <ProxyTargetSelect type={type} payload={payload ?? ''} current={proxy} />
                    </div>
                    <Switch
                      size="sm"
                      isSelected={isEnabled}
                      onValueChange={handleToggle}
                      aria-label="Toggle rule"
                    />
                  </>
                )
              })()}
          </div>
        </CardBody>
      </Card>
    </div>
  )
}

export default RuleItem
