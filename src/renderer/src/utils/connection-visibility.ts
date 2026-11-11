import { normalizeConnectionDomain } from '../../../shared/connection-domain'

export const connectionOutboundFilters = ['all', 'proxy', 'direct', 'hidden'] as const
export type ConnectionOutboundFilter = (typeof connectionOutboundFilters)[number]

export function getConnectionDomains({
  host,
  sniffHost
}: Pick<IMihomoConnectionDetail['metadata'], 'host' | 'sniffHost'>): Set<string> {
  return new Set(
    [host, sniffHost]
      .map((name) => normalizeConnectionDomain(name || ''))
      .filter((domain) => domain !== undefined)
  )
}

export function readHiddenConnectionDomains(stored: string | null): Set<string> {
  try {
    const values: unknown = JSON.parse(stored ?? '[]')
    if (Array.isArray(values)) {
      return new Set(
        values
          .filter((value): value is string => typeof value === 'string')
          .map(normalizeConnectionDomain)
          .filter((domain) => domain !== undefined)
      )
    }
  } catch {
    // Invalid local preferences fall back to an empty list.
  }
  return new Set()
}

export function filterConnectionsByOutbound(
  connections: IMihomoConnectionDetail[],
  outbound: ConnectionOutboundFilter,
  hiddenDomains: ReadonlySet<string>
): IMihomoConnectionDetail[] {
  if (outbound === 'all') return connections

  return connections.filter((connection) => {
    // Mihomo lists the actual outbound before any groups in the chain.
    const isDirect = connection.chains?.[0] === 'DIRECT'
    if (outbound === 'proxy') return !isDirect
    if (!isDirect) return false

    const hidden =
      hiddenDomains.size > 0 &&
      [...getConnectionDomains(connection.metadata)].some((domain) => hiddenDomains.has(domain))
    return outbound === 'hidden' ? hidden : !hidden
  })
}
