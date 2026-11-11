import { expect, it } from 'vitest'
import {
  filterConnectionsByOutbound,
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

it('restores valid, distinct domain names from local preferences', () => {
  expect(
    readHiddenConnectionDomains('[" EXAMPLE.test.","example.test",false,"192.0.2.1"]')
  ).toEqual(new Set(['example.test']))
  expect(readHiddenConnectionDomains('invalid JSON')).toEqual(new Set())
  expect(getConnectionDomains({ host: 'EXAMPLE.test.', sniffHost: 'example.test' })).toEqual(
    new Set(['example.test'])
  )
})
