import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { applyTailscaleRouting } from './tailscale-routing'

const { getInterfaces } = vi.hoisted(() => ({ getInterfaces: vi.fn() }))
vi.mock('../sys/interface', () => ({ getInterfaces }))

const platform = process.platform

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  getInterfaces.mockReturnValue({
    Tailscale: [{ family: 'IPv4', address: '100.103.138.58' }],
    WLAN: [{ family: 'IPv4', address: '192.168.0.116' }]
  })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
})

function config(outbound = 'WLAN'): IMihomoConfig {
  return {
    'interface-name': outbound,
    'proxy-groups': [{ name: 'Tailscale Direct (Clash Party)' }],
    rules: ['MATCH,DIRECT'],
    dns: {
      enable: true,
      'nameserver-policy': { '+.example.test': '1.1.1.1' },
      'direct-nameserver': ['system'],
      'fake-ip-filter-mode': 'rule',
      'fake-ip-filter': ['MATCH,fake-ip']
    }
  } as unknown as IMihomoConfig
}

it('prepends tailnet rules and binds MagicDNS to a unique outbound without altering the global interface', () => {
  const profile = config()
  const name = 'Tailscale Direct (Clash Party) 2'
  expect(applyTailscaleRouting(profile)).toHaveLength(3)
  expect(profile['interface-name']).toBe('WLAN')
  expect(profile.proxies).toEqual([{ name, type: 'direct', 'interface-name': 'Tailscale' }])
  expect(profile.rules).toEqual([
    `DOMAIN-SUFFIX,ts.net,${name}`,
    `IP-CIDR,100.64.0.0/10,${name},no-resolve`,
    `IP-CIDR6,fd7a:115c:a1e0::/48,${name},no-resolve`,
    'MATCH,DIRECT'
  ])
  expect(profile.dns).toMatchObject({
    'nameserver-policy': {
      '+.example.test': '1.1.1.1',
      '+.ts.net': `100.100.100.100#${encodeURIComponent(name)}`
    },
    'direct-nameserver-follow-policy': true,
    'fake-ip-filter': ['DOMAIN-SUFFIX,ts.net,real-ip', 'MATCH,fake-ip']
  })
})

it('recognizes a renamed Tailscale adapter via its IPv6 address', () => {
  getInterfaces.mockReturnValue({
    Tailnet: [{ family: 'IPv6', address: 'fd7a:115c:a1e0::abcd' }]
  })
  const profile = config()
  expect(applyTailscaleRouting(profile)).toHaveLength(3)
  expect(profile.proxies).toEqual([expect.objectContaining({ 'interface-name': 'Tailnet' })])
})

it('leaves profiles alone without an alternate Windows outbound and an addressed Tailscale adapter', () => {
  expect(applyTailscaleRouting(config(''))).toEqual([])
  expect(applyTailscaleRouting(config('Tailscale'))).toEqual([])
  getInterfaces.mockReturnValue({
    Tailscale: [{ family: 'IPv6', address: 'fe80::1' }],
    Ethernet: [{ family: 'IPv4', address: '100.64.0.2' }]
  })
  const profile = config()
  expect(applyTailscaleRouting(profile)).toEqual([])
  expect(profile).toEqual(config())
  Object.defineProperty(process, 'platform', { value: 'linux' })
  expect(applyTailscaleRouting(profile)).toEqual([])
})
