import validator from 'validator'

export function normalizeConnectionDomain(host: string): string | undefined {
  const domain = host.trim().replace(/\.$/, '').toLowerCase()
  if (!validator.isFQDN(domain, { require_tld: false })) return undefined

  try {
    const hostname = new URL(`http://${domain}`).hostname
    return validator.isIP(hostname) ? undefined : hostname
  } catch {
    return undefined
  }
}

export function normalizeConnectionDomainPattern(value: string): string | undefined {
  const pattern = value.trim()
  if (!pattern.startsWith('*.')) return normalizeConnectionDomain(pattern)

  const domain = normalizeConnectionDomain(pattern.slice(2))
  return domain?.includes('.') ? `*.${domain}` : undefined
}

export interface ConnectionDomainRoute {
  profileId: string
  groups: string[]
  target?: string
}
