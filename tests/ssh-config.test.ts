import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configWords, discoverConfigHosts } from '../src/ssh-config.ts'

test('OpenSSH aliases include nested/glob files and literal multi-alias Host blocks without exposing credentials', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-ssh-config-')), ssh = join(home, '.ssh')
  try {
    await mkdir(join(ssh, 'config.d'), { recursive: true })
    await writeFile(join(ssh, 'config'), `# comment
Host gpu-a gpu-b *.wild !denied
  IdentityFile ~/.ssh/private-key
  ProxyJump bastion
Include "config.d/*.conf"
Match exec "must-not-be-executed"
  Include "nested.conf"
Host="quoted-alias" # inline
Host *
`)
    await writeFile(join(ssh, 'config.d', 'a.conf'), 'Host gpu-a included\nInclude nested.conf\n')
    await writeFile(join(ssh, 'config.d', 'b.conf'), 'hOsT second\nInclude ../.ssh/config\n')
    await writeFile(join(ssh, 'nested.conf'), 'Host nested\nInclude config.d/*.conf\n')
    await writeFile(join(ssh, 'private-key'), 'SECRET-PRIVATE-KEY')
    const result = await discoverConfigHosts(home)
    assert.deepEqual(result.hosts.map(item => item.host), ['gpu-a', 'gpu-b', 'included', 'nested', 'quoted-alias', 'second'])
    assert.deepEqual(result.warnings, [])
    assert.equal(result.hosts.find(item => item.host === 'nested')?.source, join(ssh, 'nested.conf'))
    assert.doesNotMatch(JSON.stringify(result), /SECRET|IdentityFile|ProxyJump/u)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('missing config is empty; malformed quoting is reported without returning config contents', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-empty-config-'))
  try {
    assert.deepEqual(await discoverConfigHosts(home), { hosts: [], warnings: [] })
    await mkdir(join(home, '.ssh'))
    await writeFile(join(home, '.ssh/config'), 'Host "malformed\nHost valid\nInclude ~unknown/ssh\n')
    const result = await discoverConfigHosts(home)
    assert.deepEqual(result.hosts.map(item => item.host), ['valid'])
    assert.equal(result.warnings.length, 2)
    assert.deepEqual(configWords('Include="space path" other\\ file # comment'), ['Include', 'space path', 'other file'])
    assert.deepEqual(configWords('Include config=team.conf'), ['Include', 'config=team.conf'])
  } finally { await rm(home, { recursive: true, force: true }) }
})
