import { Button, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import { getConnectionDomains } from '@renderer/utils/connection-visibility'

interface Props {
  connection: IMihomoConnectionDetail
  x: number
  y: number
  hiddenDomains: ReadonlySet<string>
  onClose: () => void
  onOpenDetail: (connection: IMihomoConnectionDetail) => void
  onOpenDomainRoute: (domain: string) => void
  onSetDomainHidden: (domain: string, hidden: boolean) => void
}

export default function ConnectionContextMenu({
  connection,
  x,
  y,
  hiddenDomains,
  onClose,
  onOpenDetail,
  onOpenDomainRoute,
  onSetDomainHidden
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const domains = [...getConnectionDomains(connection.metadata)]
  const items = [
    { key: 'details', text: t('connections.detail.title'), run: () => onOpenDetail(connection) },
    ...domains.map((domain) => {
      const hidden = hiddenDomains.has(domain)
      return {
        key: `visibility:${domain}`,
        text: t(hidden ? 'connections.hidden.removeDomain' : 'connections.hidden.addDomain', {
          domain
        }),
        run: () => onSetDomainHidden(domain, !hidden)
      }
    }),
    ...domains.map((domain) => ({
      key: `domain:${domain}`,
      text: t('connections.detail.domainRoute', { domain }),
      run: () => onOpenDomainRoute(domain)
    }))
  ]

  return (
    <Dropdown isOpen onOpenChange={(open) => !open && onClose()} placement="bottom-start">
      <DropdownTrigger>
        <Button
          aria-label={t('connections.contextMenu')}
          tabIndex={-1}
          className="fixed pointer-events-none opacity-0 min-w-0 w-px h-px p-0"
          style={{ left: x, top: y }}
        />
      </DropdownTrigger>
      <DropdownMenu
        aria-label={t('connections.contextMenu')}
        items={items}
        autoFocus="first"
        onAction={(key) => {
          const item = items.find((item) => item.key === key)
          if (!item) return
          onClose()
          item.run()
        }}
      >
        {(item) => (
          <DropdownItem key={item.key} className="max-w-80 whitespace-normal wrap-anywhere">
            {item.text}
          </DropdownItem>
        )}
      </DropdownMenu>
    </Dropdown>
  )
}
