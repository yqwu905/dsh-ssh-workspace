import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { sshfsArguments } from '../src/sshfs.js'

const run = promisify(execFile)

test('SSHFS delegates SSH policy to OpenSSH while preserving configured alias settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-sshfs-policy-'))
  try {
    const config = join(directory, 'config')
    await writeFile(config, 'Host training\n  HostName 192.0.2.10\n  User remoteuser\n  Port 2222\n  ProxyJump gateway\n  ForwardAgent yes\n  BatchMode no\n  StrictHostKeyChecking no\n')
    const args = sshfsArguments('training', "/data/project with 'quotes'", join(directory, 'mount with spaces'))
    assert.equal(args[0], "training:/data/project with 'quotes'")
    assert.equal(args[1], join(directory, 'mount with spaces'))
    const command = args.find(arg => arg.startsWith('ssh_command='))?.slice('ssh_command='.length)
    assert.ok(command)
    // The command is fixed ASCII tokens; no user-provided host/path is interpolated.
    const [binary, ...options] = command.split(' ')
    const { stdout } = await run(binary!, [...options, '-G', '-F', config, 'training'], { timeout: 10_000 })
    const effective = new Map(stdout.trim().split('\n').map(line => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)]))
    for (const [key, value] of Object.entries({ hostname: '192.0.2.10', user: 'remoteuser', port: '2222', proxyjump: 'gateway',
      forwardagent: 'no', batchmode: 'yes', stricthostkeychecking: 'true', serveraliveinterval: '10', serveralivecountmax: '3' })) {
      assert.equal(effective.get(key), value, key)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('real SSHFS/FUSE parser rejects only the intentional probe option, never SSH policy', async t => {
  if (process.platform !== 'linux') { t.skip('This parser regression targets Linux SSHFS 3 / libfuse 3'); return }
  const binary = process.env.SSHFS_TEST_BINARY ?? 'sshfs'
  try {
    const { stdout } = await run(binary, ['--version'], { timeout: 10_000 })
    if (!/SSHFS version 3\./u.test(stdout)) { t.skip('Requires SSHFS 3'); return }
  } catch (error) {
    if (!process.env.SSHFS_TEST_BINARY && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      t.skip('Install sshfs or set SSHFS_TEST_BINARY to run the real parser regression'); return
    }
    throw error
  }
  const directory = await mkdtemp(join(tmpdir(), 'dsh-sshfs-parser-'))
  try {
    // fuse_new parses options BEFORE fuse_mount/ssh_connect. This intentional
    // unknown option makes both runs stop there: no FUSE device or server needed.
    const probe = 'dsh_intentional_parser_probe'
    const args = sshfsArguments('unused-test-host', '/data/project', directory)
    const rejected = async (options: string[]) => {
      try { await run(binary, [...options, '-o', probe], { timeout: 10_000 }) }
      catch (error) {
        const stderr = (error as { stderr?: string }).stderr ?? ''
        assert.match(stderr, /fuse: unknown option\(s\)/u)
        assert.match(stderr, new RegExp(probe, 'u'))
        return stderr
      }
      assert.fail('The intentional invalid option must stop before any mount or connection')
    }
    const legacy = await rejected([...args, '-o', 'ForwardAgent=no'])
    assert.match(legacy, /ForwardAgent=no/u, 'reproduces the reported 0.2.0 failure')
    const fixed = await rejected(args)
    assert.match(fixed, /unknown option\(s\):\s*[`']-o dsh_intentional_parser_probe['`]/u)
    assert.doesNotMatch(fixed, /ForwardAgent|ssh_command|BatchMode|StrictHostKeyChecking|ServerAlive/u)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
