import { Select, SelectItem } from '@heroui/react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import useSWR from 'swr'
import { useProfileConfig } from '@renderer/hooks/use-profile-config'
import { getConnectionDomainRoute, setConnectionDomainRoute } from '@renderer/utils/ipc'
import { toast } from '../base/toast'

const defaultKey = 'default'

export default function ConnectionDomainRoute({ domain }: { domain: string }): React.JSX.Element {
  const { t } = useTranslation()
  const { profileConfig } = useProfileConfig()
  const [saving, setSaving] = useState(false)
  const { data, error, isLoading, mutate } = useSWR(
    ['connectionDomainRoute', profileConfig?.current, domain],
    () => getConnectionDomainRoute(domain),
    { revalidateOnMount: true }
  )

  const items = [
    { id: defaultKey, name: t('connections.detail.domainRoute.default'), group: undefined },
    ...(data?.groups ?? []).map((group) => ({ id: `group:${group}`, name: group, group }))
  ]
  if (data?.target && !data.groups.includes(data.target)) {
    items.push({
      id: `group:${data.target}`,
      name: t('connections.detail.domainRoute.unavailable', { group: data.target }),
      group: data.target
    })
  }

  const changeTarget = async (group: string | undefined): Promise<void> => {
    if (!data || saving || data.target === group) return
    setSaving(true)
    try {
      await setConnectionDomainRoute(data.profileId, domain, group)
      await mutate({ ...data, target: group }, { revalidate: false })
    } catch (error) {
      toast.detailedError(String(error), t('connections.detail.domainRoute.saveFailed'))
      void mutate()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Select
      size="sm"
      label={t('connections.detail.domainRoute', { domain })}
      labelPlacement="outside"
      description={t('connections.detail.domainRoute.description')}
      errorMessage={t('connections.detail.domainRoute.loadFailed')}
      isInvalid={Boolean(error)}
      isLoading={isLoading || saving}
      isDisabled={!data || saving || (!data.groups.length && !data.target)}
      disallowEmptySelection
      selectedKeys={[data?.target ? `group:${data.target}` : defaultKey]}
      items={items}
      onSelectionChange={(keys) => {
        if (keys === 'all') return
        const item = items.find(({ id }) => keys.has(id))
        if (item) void changeTarget(item.group)
      }}
    >
      {(item) => <SelectItem key={item.id}>{item.name}</SelectItem>}
    </Select>
  )
}
