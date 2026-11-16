import { getInterfaces } from '../sys/interface'
import { ruleIdentity } from '../../shared/rule-identity'

const tailscaleIPv4Range = '100.64.0.0/10'
const tailscaleIPv6Range = 'fd7a:115c:a1e0::/48'
const tailnetDomain = '+.ts.net'
const outboundName = 'Tailscale Direct (Clash Party)'

export function applyTailscaleRouting(profile: IMihomoConfig): string[] {
  const outbound = profile['interface-name']
  if (process.platform !== 'win32' || !outbound) return []

  const tailscale = Object.entries(getInterfaces()).find(([name, addresses]) =>
    addresses?.some(({ family, address }) => {
      if (family === 'IPv6') return address.toLowerCase().startsWith('fd7a:115c:a1e0:')
      if (name.toLowerCase() !== 'tailscale' || family !== 'IPv4') return false
      const [first, second] = address.split('.').map(Number)
      return first === 100 && second >= 64 && second <= 127
    })
  )?.[0]
  if (!tailscale || tailscale.toLowerCase() === outbound.toLowerCase()) return []

  const config = profile as unknown as {
    proxies?: { name: string; type: string; 'interface-name'?: string }[]
    'proxy-groups'?: { name: string }[]
    rules?: string[]
  }
  const proxies = config.proxies ?? []
  const names = new Set([...proxies, ...(config['proxy-groups'] ?? [])].map(({ name }) => name))
  let name = outboundName
  for (let n = 2; names.has(name); n++) name = `${outboundName} ${n}`

  config.proxies = [...proxies, { name, type: 'direct', 'interface-name': tailscale }]
  config.rules = [
    `DOMAIN-SUFFIX,ts.net,${name}`,
    `IP-CIDR,${tailscaleIPv4Range},${name},no-resolve`,
    `IP-CIDR6,${tailscaleIPv6Range},${name},no-resolve`,
    ...(config.rules ?? [])
  ]

  const dns = profile.dns
  if (dns?.enable) {
    const settings = {
      ...dns,
      'nameserver-policy': {
        ...dns['nameserver-policy'],
        [tailnetDomain]: `100.100.100.100#${encodeURIComponent(name)}`
      }
    }
    // A separate DIRECT resolver must also use the MagicDNS policy.
    if (settings['direct-nameserver']?.length) settings['direct-nameserver-follow-policy'] = true
    const mode = settings['fake-ip-filter-mode'] ?? 'blacklist'
    if (mode !== 'whitelist') {
      const filter = mode === 'rule' ? 'DOMAIN-SUFFIX,ts.net,real-ip' : tailnetDomain
      settings['fake-ip-filter'] = [...new Set([filter, ...(settings['fake-ip-filter'] ?? [])])]
    }
    profile.dns = settings
  }

  return [
    ruleIdentity('DomainSuffix', 'ts.net', name),
    ruleIdentity('IPCIDR', tailscaleIPv4Range, name),
    ruleIdentity('IPCIDR', tailscaleIPv6Range, name)
  ]
}
