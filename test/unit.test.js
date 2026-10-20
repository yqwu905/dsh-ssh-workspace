// Pure-function tests; run anywhere with `node --test test/unit.test.js`.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { directorySignature, MirrorManager } from '../src/mirror.js'
import { isAllowed, isPrivateAddress, upstreamOf } from '../src/proxy.js'
import { hostOfTarget, normalizeLineEndings, posixFileUrl, remoteTargetKey } from '../src/remote-fs.js'
import { shellQuote } from '../src/ssh.js'
import { normalizeHost, sshConfigAliases } from '../src/web.js'

test('shellQuote keeps safe words and quotes everything else', () => {
  assert.equal(shellQuote('abc/def-1.2'), 'abc/def-1.2')
  assert.equal(shellQuote(''), "''")
  assert.equal(shellQuote('a b'), "'a b'")
  assert.equal(shellQuote("it's"), "'it'\\''s'")
  assert.equal(shellQuote('$(rm -rf /)'), "'$(rm -rf /)'")
})

test('remote target keys carry the server id', () => {
  const key = remoteTargetKey('web1', '/srv/app/a.txt')
  assert.equal(hostOfTarget({ targetKey: key }), 'web1')
  assert.equal(hostOfTarget({ targetKey: '/local/path' }), undefined)
  assert.equal(hostOfTarget({ targetKey: remoteTargetKey('db-2', '/') }), 'db-2')
})

test('posixFileUrl percent-encodes segments', () => {
  assert.equal(posixFileUrl('/srv/a b/#1.ts'), 'file:///srv/a%20b/%231.ts')
})

test('normalizeLineEndings collapses CRLF only', () => {
  assert.equal(normalizeLineEndings('a\r\nb\rc\n'), 'a\nb\rc\n')
})

test('proxy allow-list matching', () => {
  assert.ok(isAllowed('api.deepseek.com', ['*.deepseek.com']))
  assert.ok(isAllowed('deepseek.com', ['*.deepseek.com']))
  assert.ok(!isAllowed('evil-deepseek.com', ['*.deepseek.com']))
  assert.ok(isAllowed('pypi.org', ['pypi.org']))
  assert.ok(isAllowed('anything', ['*']))
  assert.ok(!isAllowed('pypi.org', []))
})

test('private and loopback destinations are recognized', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.ok(isPrivateAddress(address), address)
  }
  for (const address of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700::1111']) assert.ok(!isPrivateAddress(address), address)
})

test('upstream proxy resolution', () => {
  assert.equal(upstreamOf(''), undefined)
  assert.equal(upstreamOf('http://u:p@proxy:3128')?.port, '3128')
  assert.throws(() => upstreamOf('socks5://proxy:1080'))
})

test('directory signature tracks content changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fleet-sig-'))
  assert.equal(await directorySignature(join(root, 'missing')), 'absent')
  await mkdir(join(root, 'skill', 'scripts'), { recursive: true })
  await writeFile(join(root, 'skill', 'SKILL.md'), 'x')
  const first = await directorySignature(root)
  assert.equal(await directorySignature(root), first)
  await writeFile(join(root, 'skill', 'scripts', 'run.sh'), 'echo')
  const second = await directorySignature(root)
  assert.notEqual(second, first)
  await utimes(join(root, 'skill', 'SKILL.md'), new Date(), new Date(Date.now() + 5000))
  assert.notEqual(await directorySignature(root), second)
})

test('mirror paths are stable per host directory', () => {
  const mirrors = new MirrorManager(['/home/me/.dsh/skills', '/home/me/.agents/skills'], 1000, console)
  const [a, b] = mirrors.mappings('/home/alice')
  assert.match(a.remotePath, /^\/home\/alice\/\.cache\/dsh-ssh-fleet\/mirror\/[0-9a-f]{12}-skills$/)
  assert.notEqual(a.remotePath, b.remotePath)
  assert.equal(mirrors.remotePath('/home/alice', '/home/me/.dsh/skills'), a.remotePath)
})

test('normalizeHost validates and trims browser input', () => {
  assert.deepEqual(
    normalizeHost({ id: ' web1 ', host: 'web1', port: '22', sshOptions: 'ProxyJump=bastion\n\n', sandbox: 'auto', proxy: true, user: '' }),
    { id: 'web1', host: 'web1', port: 22, sshOptions: ['ProxyJump=bastion'], proxy: true },
  )
  assert.throws(() => normalizeHost({ id: '-x', host: 'h' }), /id must/)
  assert.throws(() => normalizeHost({ id: 'x', host: '-oProxyCommand=sh' }), /host must/)
  assert.throws(() => normalizeHost({ id: 'x', host: 'h', port: 70000 }), /port/)
  assert.throws(() => normalizeHost({ id: 'x', host: 'h', sshOptions: ['-F /tmp/c'] }), /Key=Value/)
  assert.throws(() => normalizeHost({ id: 'x', host: 'h', workspace: 'rel/dir' }), /workspace/)
})

test('sshConfigAliases lists concrete Host names through Include', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fleet-sshcfg-'))
  await mkdir(join(root, 'conf.d'))
  await writeFile(join(root, 'config'), `Host web1 web2 *.corp\n  User a\nInclude ${join(root, 'conf.d')}/*.conf\nHost=db1 # comment\nMatch all\n`)
  await writeFile(join(root, 'conf.d', 'a.conf'), 'Host bastion !nope "quoted"\n')
  await writeFile(join(root, 'conf.d', 'b.txt'), 'Host ignored\n')
  assert.deepEqual(await sshConfigAliases(join(root, 'config')), ['web1', 'web2', 'bastion', 'quoted', 'db1'])
  assert.deepEqual(await sshConfigAliases(join(root, 'missing')), [])
})
