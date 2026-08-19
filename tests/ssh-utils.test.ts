import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { buildRemoteCommand, hostKeyFingerprint, normalizeFingerprint, quoteShell } from '../src/ssh-utils.js'

describe('SSH command framing', () => {
  it('quotes opaque shell values without interpolation', () => {
    const value = `a'b $HOME; touch /tmp/never`
    const command = buildRemoteCommand(
      [process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', value],
      '/tmp',
      { TEST_VALUE: value },
    )
    const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([value])
    expect(quoteShell(value)).toContain(`'"'"'`)
  })

  it('rejects malformed environment names and empty argv', () => {
    expect(() => buildRemoteCommand([], '/tmp')).toThrow(/argv/u)
    expect(() => buildRemoteCommand(['true'], '/tmp', { 'BAD-NAME': 'x' })).toThrow(/environment name/u)
    expect(() => buildRemoteCommand(['bad\0arg'], '/tmp')).toThrow(/NUL/u)
  })
})

describe('host key fingerprint', () => {
  it('uses OpenSSH SHA256 spelling', () => {
    expect(hostKeyFingerprint(Buffer.from('abc')))
      .toBe('SHA256:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0')
    expect(normalizeFingerprint('ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0'))
      .toBe('SHA256:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0')
  })
})
