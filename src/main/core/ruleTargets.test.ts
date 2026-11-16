import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ruleIdentity } from '../../shared/rule-identity'

const mocks = vi.hoisted(() => ({
  directory: '',
  current: 'profile-a',
  hotReload: vi.fn<() => Promise<void>>(),
  rules: vi.fn(),
  disableRules: vi.fn(),
  tailscaleRules: vi.fn<() => readonly string[]>()
}))

vi.mock('../utils/dirs', () => ({
  ruleTargetsPath: () => join(mocks.directory, 'rule-targets.json'),
  ruleSwitchesPath: () => join(mocks.directory, 'rule-switches.json')
}))
vi.mock('../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))
vi.mock('../config/profile', () => ({ getProfileConfig: async () => ({ current: mocks.current }) }))
vi.mock('../config', () => ({ getAppConfig: async () => ({ newRulesDefaultOff: true }) }))
vi.mock('./factory', () => ({ getRuntimeTailscaleRules: mocks.tailscaleRules }))
vi.mock('./mihomoApi', () => ({
  mihomoProxies: async () => ({
    proxies: {
      GroupA: { name: 'GroupA', all: ['NodeA'] },
      GroupB: { name: 'GroupB', all: ['NodeA'] },
      NodeA: { name: 'NodeA' }
    }
  }),
  mihomoHotReloadConfig: mocks.hotReload,
  mihomoRules: mocks.rules,
  mihomoRulesDisable: mocks.disableRules
}))

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  mocks.directory = await mkdtemp(join(tmpdir(), 'connection-domain-rules-'))
  mocks.current = 'profile-a'
  mocks.hotReload.mockResolvedValue(undefined)
  mocks.tailscaleRules.mockReturnValue([])
})

afterEach(async () => {
  await rm(mocks.directory, { recursive: true, force: true })
})

function profile(...groups: string[]): IMihomoConfig {
  return {
    'proxy-groups': groups.map((name) => ({ name })),
    rules: ['DOMAIN-SUFFIX,example.test,GroupA', 'MATCH,DIRECT']
  } as unknown as IMihomoConfig
}

it('persists one exact-domain route per profile and restores the original rules on reset', async () => {
  const rulesFile = join(mocks.directory, 'rule-targets.json')
  const legacyTarget = 'DomainSuffix\x01other.test'
  await writeFile(
    rulesFile,
    JSON.stringify({ 'profile-a': { targets: { [legacyTarget]: 'GroupA' } } })
  )
  const { setConnectionDomainRoute } = await import('./ruleTargets')

  await setConnectionDomainRoute('profile-a', ' WWW.Example.Test. ', 'GroupA')
  await setConnectionDomainRoute('profile-a', 'www.example.test', 'GroupB')
  expect(JSON.parse(await readFile(rulesFile, 'utf8'))).toEqual({
    'profile-a': {
      targets: { [legacyTarget]: 'GroupA' },
      domains: { 'www.example.test': 'GroupB' }
    }
  })

  vi.resetModules()
  const {
    applyRuleTargets,
    getConnectionDomainRoute,
    setConnectionDomainRoute: setRoute
  } = await import('./ruleTargets')
  expect((await getConnectionDomainRoute('www.example.test')).target).toBe('GroupB')
  expect((await applyRuleTargets(profile('GroupA', 'GroupB'), 'profile-a')).rules).toEqual([
    'DOMAIN,www.example.test,GroupB',
    'DOMAIN-SUFFIX,other.test,GroupA',
    'DOMAIN-SUFFIX,example.test,GroupA',
    'MATCH,DIRECT'
  ])
  expect((await applyRuleTargets(profile('GroupA'), 'profile-a')).rules).not.toContain(
    'DOMAIN,www.example.test,GroupB'
  )
  expect((await applyRuleTargets(profile('GroupB'), 'profile-b')).rules).toEqual(profile().rules)

  await setRoute('profile-a', 'www.example.test', undefined)
  expect((await getConnectionDomainRoute('www.example.test')).target).toBeUndefined()
})

it('validates the domain, group and profile, and rolls back when the core rejects the reload', async () => {
  const { applyRuleTargets, getConnectionDomainRoute, setConnectionDomainRoute } =
    await import('./ruleTargets')
  await expect(setConnectionDomainRoute('profile-a', '127.0.0.1', 'GroupA')).rejects.toThrow(
    'Invalid'
  )
  await expect(setConnectionDomainRoute('profile-a', 'www.example.test', 'NodeA')).rejects.toThrow(
    'unavailable'
  )
  await expect(setConnectionDomainRoute('profile-b', 'www.example.test', 'GroupA')).rejects.toThrow(
    'changed'
  )
  expect(mocks.hotReload).not.toHaveBeenCalled()

  await setConnectionDomainRoute('profile-a', 'www.example.test', 'GroupA')
  mocks.hotReload.mockRejectedValueOnce(new Error('Core rejected config'))
  await expect(setConnectionDomainRoute('profile-a', 'www.example.test', 'GroupB')).rejects.toThrow(
    'Core rejected config'
  )
  expect((await getConnectionDomainRoute('www.example.test')).target).toBe('GroupA')
  expect((await applyRuleTargets(profile('GroupA', 'GroupB'), 'profile-a')).rules).toContain(
    'DOMAIN,www.example.test,GroupA'
  )
  expect(mocks.hotReload).toHaveBeenCalledTimes(3)
})

it('keeps an explicit domain route enabled alongside the default-off rule policy', async () => {
  const { setConnectionDomainRoute } = await import('./ruleTargets')
  await setConnectionDomainRoute('profile-a', 'www.example.test', 'GroupB')
  const domain = { type: 'Domain', payload: 'www.example.test', proxy: 'GroupB' }
  const originalId = ruleIdentity(domain.type, domain.payload, domain.proxy)
  await writeFile(
    join(mocks.directory, 'rule-switches.json'),
    JSON.stringify({
      'profile-a': { states: { [originalId]: true }, lastSeen: [] }
    })
  )
  mocks.rules.mockResolvedValue({
    rules: [
      { ...domain, index: 0 },
      { ...domain, index: 1 },
      { type: 'DomainSuffix', payload: 'other.test', proxy: 'GroupA', index: 2 }
    ]
  })

  const { applyRuleSwitches } = await import('./ruleSwitches')
  await applyRuleSwitches()
  expect(mocks.disableRules).toHaveBeenCalledWith({ '1': true, '2': true })
})

it('persists wildcard routes below exact routes and keeps them enabled on reload', async () => {
  const { applyRuleTargets, getConnectionDomainRoute, setConnectionDomainRoute } =
    await import('./ruleTargets')
  await setConnectionDomainRoute('profile-a', ' *.Example.Test. ', 'GroupB')
  await setConnectionDomainRoute('profile-a', 'c.example.test', 'GroupA')
  await expect(getConnectionDomainRoute('*.example.test')).resolves.toMatchObject({
    target: 'GroupB'
  })
  const profileWithRoutes = await applyRuleTargets(profile('GroupA', 'GroupB'), 'profile-a')
  const regex = '^.+\\.example\\.test$'
  expect(profileWithRoutes.rules).toEqual([
    'DOMAIN,c.example.test,GroupA',
    `DOMAIN-REGEX,${regex},GroupB`,
    'DOMAIN-SUFFIX,example.test,GroupA',
    'MATCH,DIRECT'
  ])

  const matches = new RegExp(regex)
  expect(matches.test('a.b.example.test')).toBe(true)
  expect(matches.test('example.test')).toBe(false)
  expect(matches.test('a.notexample.test')).toBe(false)

  mocks.rules.mockResolvedValue({
    rules: [{ index: 0, type: 'DomainRegex', payload: regex, proxy: 'GroupB' }]
  })
  const { applyRuleSwitches } = await import('./ruleSwitches')
  await applyRuleSwitches('profile-a')
  expect(mocks.disableRules).not.toHaveBeenCalled()

  await setConnectionDomainRoute('profile-a', '*.example.test', undefined)
  await expect(getConnectionDomainRoute('*.example.test')).resolves.toMatchObject({
    target: undefined
  })
})

it('changes the catch-all target in place so specific rules still take precedence', async () => {
  const { applyRuleTargets, mihomoRuleSetTarget } = await import('./ruleTargets')
  await mihomoRuleSetTarget('Match', undefined, 'GroupB')
  await mihomoRuleSetTarget('Domain', 'override.test', 'GroupA')
  const config = await applyRuleTargets(profile('GroupA', 'GroupB'), 'profile-a')

  expect(config.rules).toEqual([
    'DOMAIN,override.test,GroupA',
    'DOMAIN-SUFFIX,example.test,GroupA',
    'MATCH,GroupB'
  ])
})

it('keeps automatic Tailscale rules active when new subscription rules default to off', async () => {
  const name = 'Tailscale Direct (Clash Party)'
  const managed = [
    { type: 'DomainSuffix', payload: 'ts.net', proxy: name },
    { type: 'IPCIDR', payload: '100.64.0.0/10', proxy: name },
    { type: 'IPCIDR', payload: 'fd7a:115c:a1e0::/48', proxy: name }
  ]
  await writeFile(
    join(mocks.directory, 'rule-switches.json'),
    JSON.stringify({ 'profile-a': { states: {}, lastSeen: [] } })
  )
  mocks.tailscaleRules.mockReturnValue(managed.map((r) => ruleIdentity(r.type, r.payload, r.proxy)))
  mocks.rules.mockResolvedValue({
    rules: [
      ...managed.map((rule, index) => ({ ...rule, index, extra: { disabled: index === 0 } })),
      { type: 'DomainSuffix', payload: 'example.test', proxy: 'GroupA', index: 3 }
    ]
  })

  const { applyRuleSwitches } = await import('./ruleSwitches')
  await applyRuleSwitches('profile-a')
  expect(mocks.disableRules).toHaveBeenCalledWith({ 0: false, 3: true })
})
