import { expect, it } from 'vitest'
import {
  filterConnectionsByOutbound,
  getConnectionDomainPatterns,
  getConnectionDomains,
  readHiddenConnectionDomains
} from './connection-visibility'

function connection(host: string, chains: string[], sniffHost = ''): IMihomoConnectionDetail {
  return { chains, metadata: { host, sniffHost } } as IMihomoConnectionDetail
}

it('only hides matching direct connections in the DIRECT view', () => {
  const hiddenHost = connection(' EXAMPLE.test. ', ['DIRECT', 'Group'])
  const hiddenSniffHost = connection('', ['DIRECT'], 'example.test')
  const subdomain = connection('www.example.test', ['DIRECT'])
  const ipAddress = connection('192.0.2.1', ['DIRECT'])
  const proxied = connection('example.test', ['Proxy', 'Group'])
  const rows = [hiddenHost, hiddenSniffHost, subdomain, ipAddress, proxied]
  const domains = new Set(['example.test'])

  expect(filterConnectionsByOutbound(rows, 'direct', domains)).toEqual([subdomain, ipAddress])
  expect(filterConnectionsByOutbound(rows, 'hidden', domains)).toEqual([
    hiddenHost,
    hiddenSniffHost
  ])
  expect(filterConnectionsByOutbound(rows, 'proxy', domains)).toEqual([proxied])
  expect(filterConnectionsByOutbound(rows, 'all', domains)).toBe(rows)

  domains.delete('example.test')
  expect(filterConnectionsByOutbound(rows, 'direct', domains)).toEqual(rows.slice(0, 4))
  expect(filterConnectionsByOutbound(rows, 'hidden', domains)).toEqual([])
})

it('offers a wildcard for the registered domain without selecting a public or private suffix', () => {
  expect(getConnectionDomainPatterns({ host: 'c.bing.com', sniffHost: '' })).toEqual(
    new Set(['c.bing.com', '*.bing.com'])
  )
  expect(
    getConnectionDomainPatterns({ host: 'www.example.co.uk', sniffHost: 'a.site.github.io' })
  ).toEqual(
    new Set(['www.example.co.uk', 'a.site.github.io', '*.example.co.uk', '*.site.github.io'])
  )
  expect(getConnectionDomainPatterns({ host: '192.0.2.1', sniffHost: 'co.uk' })).toEqual(
    new Set(['co.uk'])
  )
})

it('applies a saved wildcard to direct subdomains at any depth', () => {
  const apex = connection('bing.com', ['DIRECT'])
  const host = connection('a.bing.com', ['DIRECT'])
  const sniffed = connection('', ['DIRECT'], 'a.b.bing.com')
  const suffixLookalike = connection('notbing.com', ['DIRECT'])
  const proxied = connection('b.bing.com', ['Proxy'])
  const rows = [apex, host, sniffed, suffixLookalike, proxied]
  const patterns = readHiddenConnectionDomains('[" *.BING.COM. ","*.com","*.*.bing.com"]')

  expect(patterns).toEqual(new Set(['*.bing.com']))
  expect(filterConnectionsByOutbound(rows, 'direct', patterns)).toEqual([apex, suffixLookalike])
  expect(filterConnectionsByOutbound(rows, 'hidden', patterns)).toEqual([host, sniffed])
  expect(filterConnectionsByOutbound(rows, 'proxy', patterns)).toEqual([proxied])
})

it('restores valid, distinct domain names from local preferences', () => {
  expect(
    readHiddenConnectionDomains('[" EXAMPLE.test.","example.test",false,"192.0.2.1"]')
  ).toEqual(new Set(['example.test']))
  expect(readHiddenConnectionDomains('invalid JSON')).toEqual(new Set())
  expect(getConnectionDomains({ host: 'EXAMPLE.test.', sniffHost: 'example.test' })).toEqual(
    new Set(['example.test'])
  )
})
