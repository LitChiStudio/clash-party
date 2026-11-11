import { useConnectionApps, connectionAppKey } from '@renderer/hooks/use-connection-apps'
import BasePage from '@renderer/components/base/base-page'
import { mihomoCloseAllConnections, mihomoCloseConnection } from '@renderer/utils/ipc'
import { Key, type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Badge,
  Button,
  Divider,
  Input,
  Select,
  SelectItem,
  Tab,
  Tabs,
  Dropdown,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem
} from '@heroui/react'
import { calcTraffic } from '@renderer/utils/calc'
import ConnectionItem from '@renderer/components/connections/connection-item'
import ConnectionTable, {
  CONNECTION_TABLE_COLUMNS,
  DEFAULT_CONNECTION_TABLE_COLUMN_KEYS
} from '@renderer/components/connections/connection-table'
import { Virtuoso } from 'react-virtuoso'
import dayjs from '@renderer/utils/dayjs'
import ConnectionDetailModal from '@renderer/components/connections/connection-detail-modal'
import ConnectionContextMenu from '@renderer/components/connections/connection-context-menu'
import { ConnectionDomainRouteModal } from '@renderer/components/connections/connection-domain-route'
import { CgClose, CgTrash } from 'react-icons/cg'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { HiSortAscending, HiSortDescending } from 'react-icons/hi'
import { MdViewList, MdTableChart } from 'react-icons/md'
import { HiOutlineAdjustmentsHorizontal } from 'react-icons/hi2'
import { includesIgnoreCase } from '@renderer/utils/includes'
import { useTranslation } from 'react-i18next'
import { IoMdPause, IoMdPlay } from 'react-icons/io'
import { useControledMihomoConfig } from '@renderer/hooks/use-controled-mihomo-config'
import {
  connectionOutboundFilters,
  filterConnectionsByOutbound,
  readHiddenConnectionDomains
} from '@renderer/utils/connection-visibility'

let cachedConnections: IMihomoConnectionDetail[] = []
const CONNECTIONS_FILTER_KEY = 'connections-filter'
const OUTBOUND_FILTER_KEY = 'connections-outbound'
const HIDDEN_DOMAINS_KEY = 'connections-hidden-domains'

const Connections: React.FC = () => {
  const { t } = useTranslation()
  const { controledMihomoConfig } = useControledMihomoConfig()
  const { 'find-process-mode': findProcessMode = 'always' } = controledMihomoConfig || {}
  const [filter, setFilter] = useState(() => localStorage.getItem(CONNECTIONS_FILTER_KEY) || '')
  const [outbound, setOutbound] = useState(
    () =>
      connectionOutboundFilters.find(
        (value) => value === localStorage.getItem(OUTBOUND_FILTER_KEY)
      ) ?? 'all'
  )
  const [hiddenDomains, setHiddenDomains] = useState(() =>
    readHiddenConnectionDomains(localStorage.getItem(HIDDEN_DOMAINS_KEY))
  )
  const [ruleFilter, setRuleFilter] = useState('')
  const { appConfig, patchAppConfig } = useAppConfig()
  const appConfigValues: Partial<IAppConfig> = appConfig ?? {}
  const {
    connectionDirection = 'asc',
    connectionOrderBy = 'time',
    connectionViewMode = 'list',
    connectionTableColumns = DEFAULT_CONNECTION_TABLE_COLUMN_KEYS,
    connectionTableColumnWidths,
    connectionTableSortColumn,
    connectionTableSortDirection,
    displayIcon = true,
    displayAppName = true
  } = appConfigValues
  const [connectionsInfo, setConnectionsInfo] = useState<IMihomoConnectionsInfo>()
  const [allConnections, setAllConnections] = useState<IMihomoConnectionDetail[]>(cachedConnections)
  const [activeConnections, setActiveConnections] = useState<IMihomoConnectionDetail[]>([])
  const [closedConnections, setClosedConnections] = useState<IMihomoConnectionDetail[]>([])
  const connectionApps = useConnectionApps(
    activeConnections,
    closedConnections,
    findProcessMode !== 'off' && (displayIcon || displayAppName)
  )
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false)
  const [selected, setSelected] = useState<IMihomoConnectionDetail>()
  const [contextMenu, setContextMenu] = useState<{
    connection: IMihomoConnectionDetail
    x: number
    y: number
  }>()
  const [routeDomain, setRouteDomain] = useState<string>()
  const [tab, setTab] = useState('active')
  const [isPaused, setIsPaused] = useState(false)
  const [viewMode, setViewMode] = useState<'list' | 'table'>(connectionViewMode)
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(new Set(connectionTableColumns))

  const activeConnectionsRef = useRef(activeConnections)
  const allConnectionsRef = useRef(allConnections)

  useEffect(() => {
    activeConnectionsRef.current = activeConnections
    allConnectionsRef.current = allConnections
  }, [activeConnections, allConnections])

  useEffect(() => {
    localStorage.setItem(CONNECTIONS_FILTER_KEY, filter)
  }, [filter])

  useEffect(() => {
    localStorage.setItem(OUTBOUND_FILTER_KEY, outbound)
  }, [outbound])

  useEffect(() => {
    localStorage.setItem(HIDDEN_DOMAINS_KEY, JSON.stringify([...hiddenDomains]))
  }, [hiddenDomains])

  const setDomainHidden = useCallback((domain: string, hidden: boolean): void => {
    setHiddenDomains((previous) => {
      const next = new Set(previous)
      if (hidden) next.add(domain)
      else next.delete(domain)
      return next
    })
  }, [])

  useEffect(() => {
    setViewMode(connectionViewMode)
  }, [connectionViewMode])

  useEffect(() => {
    setVisibleColumns(new Set(connectionTableColumns))
  }, [connectionTableColumns])

  const selectedConnection = useMemo(() => {
    if (!selected) return undefined
    return (
      activeConnections.find((c) => c.id === selected.id) ||
      closedConnections.find((c) => c.id === selected.id) ||
      selected
    )
  }, [selected, activeConnections, closedConnections])

  const handleColumnWidthChange = useCallback(
    async (widths: Record<string, number>) => {
      await patchAppConfig({ connectionTableColumnWidths: widths })
    },
    [patchAppConfig]
  )

  const handleSortChange = useCallback(
    async (column: string, direction: 'asc' | 'desc') => {
      await patchAppConfig({
        connectionTableSortColumn: column,
        connectionTableSortDirection: direction
      })
    },
    [patchAppConfig]
  )

  const ruleKeyOf = (c: IMihomoConnectionDetail): string => `${c.rule}::${c.rulePayload ?? ''}`
  const ruleLabelOf = (c: IMihomoConnectionDetail): string =>
    `${c.rule}${c.rulePayload ? `(${c.rulePayload})` : ''}`

  // 当前标签页连接里实际命中的规则名（去重），用于「规则」下拉
  const ruleOptions = useMemo(() => {
    const conns = tab === 'active' ? activeConnections : closedConnections
    const map = new Map<string, string>()
    for (const c of conns) map.set(ruleKeyOf(c), ruleLabelOf(c))
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1], 'zh-Hans-CN'))
  }, [activeConnections, closedConnections, tab])

  const filteredConnections = useMemo(() => {
    const connections = tab === 'active' ? activeConnections : closedConnections

    let filtered =
      filter === ''
        ? connections
        : connections.filter((connection) => {
            const raw = JSON.stringify(connection)
            return includesIgnoreCase(raw, filter)
          })

    filtered = filterConnectionsByOutbound(filtered, outbound, hiddenDomains)

    // 规则筛选：按命中的规则（类型 + payload）精确匹配
    if (ruleFilter) {
      filtered = filtered.filter((c) => ruleKeyOf(c) === ruleFilter)
    }

    if (viewMode === 'list' && connectionOrderBy) {
      return [...filtered].sort((a, b) => {
        let comparison = 0
        switch (connectionOrderBy) {
          case 'time':
            comparison = dayjs(a.start).unix() - dayjs(b.start).unix()
            break
          case 'upload':
            comparison = a.upload - b.upload
            break
          case 'download':
            comparison = a.download - b.download
            break
          case 'uploadSpeed':
            comparison = (a.uploadSpeed || 0) - (b.uploadSpeed || 0)
            break
          case 'downloadSpeed':
            comparison = (a.downloadSpeed || 0) - (b.downloadSpeed || 0)
            break
        }
        return connectionDirection === 'asc' ? comparison : -comparison
      })
    }

    return filtered
  }, [
    activeConnections,
    closedConnections,
    tab,
    filter,
    outbound,
    hiddenDomains,
    ruleFilter,
    connectionDirection,
    connectionOrderBy,
    viewMode
  ])

  const closeAllConnections = useCallback((): void => {
    tab === 'active' ? mihomoCloseAllConnections() : trashAllClosedConnection()
  }, [tab])

  const closeConnection = useCallback(
    (id: string): void => {
      tab === 'active' ? mihomoCloseConnection(id) : trashClosedConnection(id)
    },
    [tab]
  )

  const trashAllClosedConnection = (): void => {
    setClosedConnections((closedConns) => {
      const trashIds = new Set(closedConns.map((conn) => conn.id))
      setAllConnections((allConns) => {
        const filtered = allConns.filter((conn) => !trashIds.has(conn.id))
        cachedConnections = filtered
        return filtered
      })
      return []
    })
  }

  const trashClosedConnection = (id: string): void => {
    setAllConnections((allConns) => {
      const filtered = allConns.filter((conn) => conn.id !== id)
      cachedConnections = filtered
      return filtered
    })
    setClosedConnections((closedConns) => closedConns.filter((conn) => conn.id !== id))
  }

  useEffect(() => {
    let pendingInfo: IMihomoConnectionsInfo | undefined
    let frameId: number | undefined

    const updateConnections = (info: IMihomoConnectionsInfo): void => {
      setConnectionsInfo(info)

      if (!info.connections) return
      // O(n+m) merge using Map instead of O(n²) unionWith
      const allConnsMap = new Map(allConnectionsRef.current.map((c) => [c.id, c]))
      activeConnectionsRef.current.forEach((c) => allConnsMap.set(c.id, c))
      const allConns = Array.from(allConnsMap.values())

      const prevConnMap = new Map(activeConnectionsRef.current.map((c) => [c.id, c]))
      const activeConns = info.connections.map((conn) => {
        const preConn = prevConnMap.get(conn.id)
        return {
          ...conn,
          isActive: true,
          downloadSpeed: preConn ? conn.download - preConn.download : 0,
          uploadSpeed: preConn ? conn.upload - preConn.upload : 0
        }
      })
      // O(n+m) difference using Set instead of O(n²) differenceWith
      const activeIdSet = new Set(activeConns.map((c) => c.id))
      const closedConns = allConns
        .filter((c) => !activeIdSet.has(c.id))
        .map((conn) => ({
          ...conn,
          isActive: false,
          downloadSpeed: 0,
          uploadSpeed: 0
        }))

      const sliced = allConns.slice(-(activeConns.length + 200))
      setActiveConnections(activeConns)
      setClosedConnections(closedConns)
      setAllConnections(sliced)
      cachedConnections = sliced
    }

    const handler = (_e: unknown, ...args: unknown[]): void => {
      const info = args[0] as IMihomoConnectionsInfo | undefined
      if (!info || document.hidden) return

      pendingInfo = info
      if (frameId !== undefined) return
      frameId = window.requestAnimationFrame(() => {
        frameId = undefined
        const latestInfo = pendingInfo
        pendingInfo = undefined
        if (latestInfo && !document.hidden) updateConnections(latestInfo)
      })
    }

    let unsubscribe: (() => void) | null = null
    if (!isPaused) {
      unsubscribe = window.electron.ipcRenderer.on('mihomoConnections', handler)
    }

    return (): void => {
      unsubscribe?.()
      if (frameId !== undefined) window.cancelAnimationFrame(frameId)
      pendingInfo = undefined
    }
  }, [isPaused])

  const openConnectionDetail = useCallback((connection: IMihomoConnectionDetail): void => {
    setSelected(connection)
    setIsDetailModalOpen(true)
  }, [])
  const openContextMenu = useCallback(
    (event: MouseEvent, connection: IMihomoConnectionDetail): void => {
      event.preventDefault()
      event.stopPropagation()
      const { clientX, clientY } = event
      const anchor = event.currentTarget.getBoundingClientRect()
      setContextMenu({
        connection,
        x: clientX || anchor.left,
        y: clientY || anchor.top
      })
    },
    []
  )
  const togglePause = useCallback(() => {
    setIsPaused((prev) => !prev)
  }, [])

  const renderConnectionItem = useCallback(
    (i: number, connection: IMihomoConnectionDetail) => {
      const info = connectionApps[connectionAppKey(connection)]
      const iconUrl = (displayIcon && findProcessMode !== 'off' && info?.icon) || ''
      const displayName = displayAppName && findProcessMode !== 'off' ? info?.name : undefined

      return (
        <ConnectionItem
          setSelected={setSelected}
          setIsDetailModalOpen={setIsDetailModalOpen}
          selected={selected}
          iconUrl={iconUrl}
          displayIcon={displayIcon && findProcessMode !== 'off'}
          displayName={displayName}
          close={closeConnection}
          onContextMenu={openContextMenu}
          index={i}
          key={connection.id}
          info={connection}
        />
      )
    },
    [
      displayIcon,
      connectionApps,
      selected,
      closeConnection,
      openContextMenu,
      findProcessMode,
      displayAppName
    ]
  )

  return (
    <BasePage
      title={t('connections.title')}
      header={
        <div className="flex">
          <div className="flex items-center">
            <span className="mx-1 text-gray-400">
              ↑ {calcTraffic(connectionsInfo?.uploadTotal ?? 0)}{' '}
            </span>
            <span className="mx-1 text-gray-400">
              ↓ {calcTraffic(connectionsInfo?.downloadTotal ?? 0)}{' '}
            </span>
          </div>
          <Badge
            className="app-nodrag pointer-events-none mt-2"
            color="primary"
            variant="flat"
            showOutline={false}
            content={filteredConnections.length}
          >
            <Button
              className="app-nodrag ml-1"
              title={
                viewMode === 'list'
                  ? t('connections.table.switchToTable')
                  : t('connections.table.switchToList')
              }
              isIconOnly
              size="sm"
              variant="light"
              onPress={async () => {
                const newMode = viewMode === 'list' ? 'table' : 'list'
                setViewMode(newMode)
                await patchAppConfig({ connectionViewMode: newMode })
              }}
            >
              {viewMode === 'list' ? (
                <MdTableChart className="text-lg" />
              ) : (
                <MdViewList className="text-lg" />
              )}
            </Button>
            <Button
              className="app-nodrag ml-1"
              title={isPaused ? t('connections.resume') : t('connections.pause')}
              isIconOnly
              size="sm"
              variant="light"
              onPress={togglePause}
            >
              {isPaused ? <IoMdPlay className="text-lg" /> : <IoMdPause className="text-lg" />}
            </Button>
            <Button
              className="app-nodrag ml-1"
              title={t('connections.closeAll')}
              isIconOnly
              size="sm"
              variant="light"
              onPress={() => {
                if (filter === '') {
                  closeAllConnections()
                } else {
                  filteredConnections.forEach((conn) => {
                    closeConnection(conn.id)
                  })
                }
              }}
            >
              {tab === 'active' ? <CgClose className="text-lg" /> : <CgTrash className="text-lg" />}
            </Button>
          </Badge>
        </div>
      }
    >
      {isDetailModalOpen && selectedConnection && (
        <ConnectionDetailModal
          onClose={() => setIsDetailModalOpen(false)}
          connection={selectedConnection}
        />
      )}
      {contextMenu && (
        <ConnectionContextMenu
          key={`${contextMenu.connection.id}:${contextMenu.x}:${contextMenu.y}`}
          {...contextMenu}
          hiddenDomains={hiddenDomains}
          onClose={() => setContextMenu(undefined)}
          onOpenDetail={openConnectionDetail}
          onOpenDomainRoute={setRouteDomain}
          onSetDomainHidden={setDomainHidden}
        />
      )}
      {routeDomain && (
        <ConnectionDomainRouteModal
          domain={routeDomain}
          onClose={() => setRouteDomain(undefined)}
        />
      )}
      <div className="overflow-x-auto sticky top-0 z-40">
        <div className="flex p-2 gap-2">
          <Tabs
            size="sm"
            color={tab === 'active' ? 'primary' : 'danger'}
            selectedKey={tab}
            variant="underlined"
            className="w-fit h-8"
            onSelectionChange={(key: Key) => {
              setTab(key as string)
            }}
          >
            <Tab
              key="active"
              title={
                <Badge
                  color={tab === 'active' ? 'primary' : 'default'}
                  size="sm"
                  shape="circle"
                  variant="flat"
                  content={activeConnections.length}
                  showOutline={false}
                >
                  <span className="p-1">{t('connections.active')}</span>
                </Badge>
              }
            />
            <Tab
              key="closed"
              title={
                <Badge
                  color={tab === 'closed' ? 'danger' : 'default'}
                  size="sm"
                  shape="circle"
                  variant="flat"
                  content={closedConnections.length}
                  showOutline={false}
                >
                  <span className="p-1">{t('connections.closed')}</span>
                </Badge>
              }
            />
          </Tabs>
          <Input
            variant="flat"
            size="sm"
            value={filter}
            placeholder={t('connections.filter')}
            isClearable
            onValueChange={setFilter}
          />

          <Select
            size="sm"
            className="w-40 min-w-32"
            classNames={{ popoverContent: 'min-w-32' }}
            aria-label={t('connections.outbound')}
            selectedKeys={[outbound]}
            disallowEmptySelection
            onSelectionChange={(keys) => {
              if (keys === 'all') return
              const value = connectionOutboundFilters.find((option) => keys.has(option))
              if (value) setOutbound(value)
            }}
          >
            {connectionOutboundFilters.map((value) => (
              <SelectItem key={value}>{t(`connections.outbound.${value}`)}</SelectItem>
            ))}
          </Select>

          {outbound === 'hidden' && hiddenDomains.size > 0 && (
            <Dropdown>
              <DropdownTrigger>
                <Button size="sm" variant="flat" className="shrink-0">
                  {t('connections.hidden.remove')}
                </Button>
              </DropdownTrigger>
              <DropdownMenu
                aria-label={t('connections.hidden.remove')}
                onAction={(domain) => setDomainHidden(String(domain), false)}
              >
                {[...hiddenDomains].sort().map((domain) => (
                  <DropdownItem key={domain} className="max-w-80 whitespace-normal wrap-anywhere">
                    {domain}
                  </DropdownItem>
                ))}
              </DropdownMenu>
            </Dropdown>
          )}

          {/* 规则筛选：按当前连接实际命中的规则名过滤 */}
          <Select
            size="sm"
            className="w-64 min-w-52"
            classNames={{ popoverContent: 'min-w-52' }}
            aria-label={t('connections.ruleFilter')}
            selectedKeys={[ruleFilter || 'ALL']}
            onSelectionChange={(keys) => {
              const v = Array.from(keys as Set<string>)[0] ?? 'ALL'
              setRuleFilter(v === 'ALL' ? '' : v)
            }}
            isDisabled={ruleOptions.length === 0}
            items={[['ALL', t('connections.ruleAll')], ...ruleOptions]}
          >
            {([key, label]: [string, string]) => (
              <SelectItem key={key} className="truncate">
                {label}
              </SelectItem>
            )}
          </Select>

          {viewMode === 'table' && (
            <Dropdown>
              <DropdownTrigger>
                <Button
                  size="sm"
                  variant="flat"
                  startContent={<HiOutlineAdjustmentsHorizontal className="text-2xl" />}
                >
                  {t('connections.table.columns')}
                </Button>
              </DropdownTrigger>
              <DropdownMenu
                aria-label="Column visibility"
                closeOnSelect={false}
                selectionMode="multiple"
                selectedKeys={visibleColumns}
                onSelectionChange={async (keys) => {
                  const newColumns =
                    keys === 'all'
                      ? CONNECTION_TABLE_COLUMNS.map((column) => column.key)
                      : Array.from(keys).map(String)
                  setVisibleColumns(new Set(newColumns))
                  await patchAppConfig({ connectionTableColumns: newColumns })
                }}
              >
                {CONNECTION_TABLE_COLUMNS.map((column) => (
                  <DropdownItem key={column.key}>{t(column.labelKey)}</DropdownItem>
                ))}
              </DropdownMenu>
            </Dropdown>
          )}

          {viewMode === 'list' && (
            <>
              <Select
                classNames={{ trigger: 'data-[hover=true]:bg-default-200' }}
                size="sm"
                className="w-45 min-w-32.75"
                aria-label={t('connections.orderBy')}
                selectedKeys={[connectionOrderBy]}
                disallowEmptySelection={true}
                onSelectionChange={async (v) => {
                  await patchAppConfig({
                    connectionOrderBy: v.currentKey as
                      'time' | 'upload' | 'download' | 'uploadSpeed' | 'downloadSpeed'
                  })
                }}
              >
                <SelectItem key="time">{t('connections.time')}</SelectItem>
                <SelectItem key="upload">{t('connections.uploadAmount')}</SelectItem>
                <SelectItem key="download">{t('connections.downloadAmount')}</SelectItem>
                <SelectItem key="uploadSpeed">{t('connections.uploadSpeed')}</SelectItem>
                <SelectItem key="downloadSpeed">{t('connections.downloadSpeed')}</SelectItem>
              </Select>
              <Button
                size="sm"
                isIconOnly
                className="bg-content2"
                onPress={() => {
                  patchAppConfig({
                    connectionDirection: connectionDirection === 'asc' ? 'desc' : 'asc'
                  })
                }}
              >
                {connectionDirection === 'asc' ? (
                  <HiSortAscending className="text-lg" />
                ) : (
                  <HiSortDescending className="text-lg" />
                )}
              </Button>
            </>
          )}
        </div>
        <Divider />
      </div>
      <div className="h-[calc(100vh-100px)] mt-px">
        {viewMode === 'list' ? (
          <Virtuoso data={filteredConnections} itemContent={renderConnectionItem} />
        ) : (
          <ConnectionTable
            connections={filteredConnections}
            onOpenDetail={openConnectionDetail}
            onContextMenu={openContextMenu}
            close={closeConnection}
            visibleColumns={visibleColumns}
            columnWidths={connectionTableColumnWidths}
            sortColumn={connectionTableSortColumn}
            sortDirection={connectionTableSortDirection}
            onColumnWidthChange={handleColumnWidthChange}
            onSortChange={handleSortChange}
          />
        )}
      </div>
    </BasePage>
  )
}

export default Connections
