// End-to-end tests against a real dsh runtime (SDK profile), a scripted model
// and the two-server lab from test/lab/setup-sshd.sh. Skipped unless
// FLEET_LAB and DSH_HOME point at a prepared lab.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { startMockLlm, toolResults } from './mock-llm.js'

const LAB = process.env.FLEET_LAB
const HOME = process.env.DSH_HOME ?? ''
const skip = LAB === undefined ? 'set FLEET_LAB/DSH_HOME (see test/lab/setup-sshd.sh)' : false
const PROFILE = process.env.FLEET_PROFILE ?? 'fleet-e2e'
const anchor = host => join(HOME, 'ssh-fleet', 'anchors', host)
const who = { tool: 'bash', input: { command: 'echo "WHO $(whoami) $(pwd)"', description: 'Show identity' } }

/** Remote shell helper for assertions. */
function onServer(host, command) {
  return execFileSync('ssh', ['-o', 'BatchMode=yes', host, command], { encoding: 'utf8' })
}

/**
 * Run `fn` with a fresh harness wired to a scripted model.
 * @param {(request: any) => any[]} script
 * @param {(harness: any, mock: any) => Promise<void>} fn
 * @param {{ mode?: string }} [opts]
 */
async function withHarness(script, fn, opts = {}) {
  const { DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client')
  const mock = await startMockLlm(script)
  process.env.DEEPSEEK_BASE_URL = mock.baseUrl
  process.env.DEEPSEEK_API_KEY = 'mock-key'
  process.env.DSH_PERMISSION_MODE = opts.mode ?? 'danger-full-access'
  const cwd = join(LAB ?? '/tmp', 'localwork')
  mkdirSync(cwd, { recursive: true })
  const harness = new DeepSeekHarness({ profile: PROFILE, cwd, dshBin: realpathSync(execFileSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' }).trim()) })
  try {
    await fn(harness, mock)
  } finally {
    await harness.close()
    await mock.close()
  }
}

/** Text the user side wrote (prompts and notices), excluding tool traffic. */
function userText(request) {
  const parts = []
  for (const message of request.messages ?? []) {
    if (message.role !== 'user') continue
    if (typeof message.content === 'string') parts.push(message.content)
    else for (const block of message.content ?? []) if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}

const userTextOf = request => userText(request)

/** Tool results of the last tool-bearing request whose user text contains `marker`. */
function resultsFor(mock, marker) {
  const requests = mock.requests.filter(r => Array.isArray(r.tools) && r.tools.length > 0 && userText(r).includes(marker))
  return requests.length === 0 ? [] : toolResults(requests.at(-1)).map(r => r.content.trim())
}

/** Pick a script by a marker in the conversation's user text. */
const byMarker = table => (request) => {
  const text = userText(request)
  for (const [marker, steps] of Object.entries(table)) if (text.includes(marker)) return steps
  return []
}

describe('dsh-ssh-fleet end to end', { skip, timeout: 240000 }, () => {
  test('one instance runs sessions on several servers concurrently', async () => {
    const steps = [
      { tool: 'bash', input: { command: 'echo "WHO $(whoami) $(pwd)"; sleep 3', description: 'Identity then wait' } },
      { tool: 'write', input: { file_path: 'fleet-e2e.txt', content: 'alpha\nbeta\n' } },
      { tool: 'read', input: { file_path: 'fleet-e2e.txt' } },
      { tool: 'edit', input: { file_path: 'fleet-e2e.txt', old_string: 'beta', new_string: 'gamma' } },
      { tool: 'grep', input: { pattern: 'gam+a', include: 'fleet-e2e.txt' } },
      { tool: 'glob', input: { pattern: 'fleet-e2e.*' } },
      { text: 'done' },
    ]
    onServer('web1', 'rm -f ~/proj/fleet-e2e.txt')
    onServer('db1', 'rm -f ~/fleet-e2e.txt')
    await withHarness(() => steps, async (harness, mock) => {
      const web = harness.session()
      const db = harness.session()
      const local = harness.session()
      await web.setWorkingDirectory(anchor('web1'))
      await db.setWorkingDirectory(anchor('db1'))
      const started = Date.now()
      await Promise.all([web.run('task WEB'), db.run('task DB'), local.run('task LOCAL')])
      const elapsed = Date.now() - started
      const web1 = resultsFor(mock, 'task WEB')
      const db1 = resultsFor(mock, 'task DB')
      const loc = resultsFor(mock, 'task LOCAL')
      assert.match(web1[0], /^WHO alice \/home\/alice\/proj$/)
      assert.match(db1[0], /^WHO bob \/home\/bob$/)
      assert.match(loc[0], new RegExp(`^WHO \\S+ ${join(LAB, 'localwork')}$`))
      assert.match(web1[4], /gamma/)
      assert.match(web1[5], /fleet-e2e\.txt/)
      assert.equal(onServer('web1', 'cat ~/proj/fleet-e2e.txt'), 'alpha\ngamma\n')
      assert.equal(onServer('db1', 'cat ~/fleet-e2e.txt'), 'alpha\ngamma\n')
      assert.ok(elapsed < 3 * 3000 + 20000, `sessions ran concurrently (${elapsed} ms)`)
      assert.equal(await web.getWorkingDirectory(), '/home/alice/proj')
    })
  })

  test('anchors encode any remote directory (Web workspaces)', async () => {
    onServer('web1', 'mkdir -p ~/proj/"anchored dir"')
    await withHarness(() => [who, { text: 'done' }], async (harness, mock) => {
      const session = harness.session()
      await session.setWorkingDirectory(`${anchor('web1')}/home/alice/proj/anchored dir`)
      await session.run('anchored TASK')
      assert.deepEqual(resultsFor(mock, 'anchored TASK'), ['WHO alice /home/alice/proj/anchored dir'])
      assert.equal(await session.getWorkingDirectory(), '/home/alice/proj/anchored dir')
    })
  })

  test('/ssh binds, switches and returns a session', async () => {
    const slash = line => ({ tool: 'test_slash', input: { line } })
    const steps = [slash('/ssh'), slash('/ssh db1 /tmp'), who, slash('/ssh web1'), who,
      slash('/ssh nosuch'), slash('/ssh ghost'), who, slash('/ssh local'), who, slash('/ssh check db1'), { text: 'done' }]
    await withHarness(() => steps, async (harness, mock) => {
      await harness.session().run('slash TASK')
      const r = resultsFor(mock, 'slash TASK')
      assert.match(r[0], /This session runs locally[\s\S]*web1[\s\S]*db1/)
      assert.match(r[1], /^\[success\] Session bound to db1/)
      assert.equal(r[2], 'WHO bob /tmp')
      assert.match(r[3], /^\[success\] Session bound to web1/)
      assert.equal(r[4], 'WHO alice /home/alice/proj')
      assert.match(r[5], /^\[error\] ssh-fleet: unknown host "nosuch"/)
      assert.match(r[6], /^\[error\] cannot connect to ghost/)
      assert.equal(r[7], 'WHO alice /home/alice/proj', 'a failed bind keeps the previous binding')
      assert.match(r[8], /^\[success\] Session returned to the local machine/)
      assert.match(r[9], new RegExp(`^WHO \\S+ ${join(LAB, 'localwork')}$`))
      assert.match(r[10], /^\[success\] db1: ok, Linux/)
    })
  })

  test('anchor sessions can go local; removed servers fail closed', async () => {
    const hostsFile = join(HOME, 'ssh-fleet', 'hosts.json')
    const original = readFileSync(hostsFile, 'utf8')
    const slash = line => ({ tool: 'test_slash', input: { line } })
    const steps = [who, slash('/ssh local'), who, slash('/ssh db1'), slash('/ssh reload'), who, { text: 'done' }]
    const script = (request) => {
      // Drop db1 from the hosts file just before the reload step.
      const turn = (request.messages ?? []).filter(m => m.role === 'assistant').length
      if (turn === 4) {
        const hosts = JSON.parse(original)
        hosts.hosts = hosts.hosts.filter(h => h.id !== 'db1')
        writeFileSync(hostsFile, JSON.stringify(hosts))
      }
      return steps
    }
    let sessionId
    try {
      await withHarness(script, async (harness, mock) => {
        const s = harness.session()
        await s.setWorkingDirectory(anchor('web1'))
        sessionId = (await s.run('anchor ANCHOR')).sessionId
        const r = resultsFor(mock, 'anchor ANCHOR')
        assert.equal(r[0], 'WHO alice /home/alice/proj')
        assert.match(r[1], /^\[success\] Session returned to the local machine/)
        assert.match(r[2], /^WHO \S+ \//)
        assert.doesNotMatch(r[2], /alice|anchors/)
        assert.match(r[3], /^\[success\] Session bound to db1/)
        // Fail closed: after the reload drops db1, the next request is refused
        // (no request carries the reload result, and nothing ran locally).
        assert.equal(r.length, 4)
        assert.equal(mock.requests.filter(q => Array.isArray(q.tools) && q.tools.length > 0 && userTextOf(q).includes('anchor ANCHOR')).length, 5)
      })
      writeFileSync(hostsFile, original)
      await withHarness(() => steps, async (harness, mock) => {
        const resumed = await harness.resumeSession(sessionId)
        await resumed.run('anchor AGAIN')
        assert.equal(resultsFor(mock, 'anchor AGAIN').at(-1), 'WHO bob /home/bob')
      })
    } finally {
      writeFileSync(hostsFile, original)
    }
  })

  test('subagents inherit the server and bindings survive a restart', async () => {
    // Checked in order: a parent conversation also receives the child's
    // completion notice, so the more specific markers come first.
    const script = byMarker({
      'resume RESUME': [who, who, who, who, who, who, { text: 'resumed' }],
      'parent PARENT': [{ tool: 'subagent', input: { description: 'Probe child', prompt: 'CHILD-PROBE: report identity' } }, { text: 'parent done' }],
      'CHILD-PROBE': [who, { text: 'child done' }],
    })
    let sessionId
    await withHarness(script, async (harness, mock) => {
      const parent = harness.session()
      await parent.setWorkingDirectory(anchor('db1'))
      sessionId = (await parent.run('parent PARENT')).sessionId
      for (let i = 0; i < 60 && !resultsFor(mock, 'CHILD-PROBE').some(x => x.startsWith('WHO')); i++) {
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      assert.ok(resultsFor(mock, 'CHILD-PROBE').includes('WHO bob /home/bob'))
    })
    await withHarness(script, async (harness, mock) => {
      const resumed = await harness.resumeSession(sessionId)
      await resumed.run('resume RESUME')
      assert.equal(resultsFor(mock, 'resume RESUME').at(-1), 'WHO bob /home/bob')
    })
  })

  test('workspace-write policy confines remote file writes', async () => {
    const confinedBash = [
      'echo ws > policy-bash.txt && echo ws-ok',
      'echo x >> ~/.cache/dsh-ssh-fleet/helper-probe 2>/dev/null && echo state-WRITABLE || echo state-protected',
      'touch ~/policy-escape.txt 2>/dev/null && echo escape-WRITABLE || echo escape-denied',
    ].join('; ')
    const steps = [
      { tool: 'write', input: { file_path: 'policy-inside.txt', content: 'ok\n' } },
      { tool: 'write', input: { file_path: '/home/alice/policy-outside.txt', content: 'no\n' } },
      { tool: 'bash', input: { command: confinedBash, description: 'Confined writes' } },
      { text: 'done' },
    ]
    onServer('web1', 'rm -f ~/proj/policy-inside.txt ~/proj/policy-bash.txt ~/policy-outside.txt ~/policy-escape.txt')
    await withHarness(() => steps, async (harness, mock) => {
      const s = harness.session()
      await s.setWorkingDirectory(anchor('web1'))
      await s.run('policy POLICY')
      const r = resultsFor(mock, 'policy POLICY')
      assert.match(r[0], /policy-inside\.txt/)
      assert.match(r[1], /file access denied under workspace-write mode/)
      if (onServer('web1', 'command -v bwrap || true').trim() !== '') {
        assert.match(r[2], /^ws-ok\nstate-protected\nescape-denied/)
      } else {
        assert.match(r[2], /no usable bubblewrap/)
      }
      assert.match(onServer('web1', 'ls ~/proj/policy-inside.txt; ls ~/policy-outside.txt 2>&1 || true'), /No such file/)
    }, { mode: 'workspace-write' })
  })

  test('the host proxy serves allowed destinations to authenticated clients only', async () => {
    const api = createServer((req, res) => res.end(`api answered ${req.url}\n`))
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
    const port = /** @type {any} */ (api.address()).port
    const command = [
      `curl -s http://llm-api.fleet:${port}/v1/models`,
      // Same forwarded port without the credential:
      'curl -s -o /dev/null -w "noauth %{http_code}\\n" --proxy "http://${HTTP_PROXY##*@}" http://llm-api.fleet/',
      'curl -s -o /dev/null -w "blocked %{http_code}\\n" http://example.com/',
    ].join('; ')
    const steps = [{ tool: 'bash', input: { command, description: 'Probe proxy' } }, { text: 'done' }]
    try {
      await withHarness(() => steps, async (harness, mock) => {
        const s = harness.session()
        await s.setWorkingDirectory(anchor('web1'))
        await s.run('proxy PROXY')
        assert.equal(resultsFor(mock, 'proxy PROXY')[0], 'api answered /v1/models\nnoauth 407\nblocked 403')
      })
    } finally {
      api.close()
    }
  })

  test('host skills are mirrored and refreshed on every server', async () => {
    const script = join(HOME, 'skills', 'hello-fleet', 'scripts', 'hello.sh')
    const steps = [
      { tool: 'skill', input: { name: 'hello-fleet' } },
      { tool: 'bash', input: { command: 'sh "$(ls -d ~/.cache/dsh-ssh-fleet/mirror/*-skills/hello-fleet | head -1)/scripts/hello.sh"', description: 'Run skill script' } },
      { text: 'done' },
    ]
    writeFileSync(script, '#!/bin/sh\necho "hello-fleet v1 as $(whoami)"\n')
    await withHarness(() => steps, async (harness, mock) => {
      const s = harness.session()
      await s.setWorkingDirectory(anchor('db1'))
      await s.run('skill SKILL-1')
      const r = resultsFor(mock, 'skill SKILL-1')
      assert.match(r[0], /Base directory for this skill: \/home\/bob\/\.cache\/dsh-ssh-fleet\/mirror\//)
      assert.equal(r[1], 'hello-fleet v1 as bob')
      writeFileSync(script, '#!/bin/sh\necho "hello-fleet v2 as $(whoami)"\n')
      await new Promise(resolve => setTimeout(resolve, 3500))
      const t = harness.session()
      await t.setWorkingDirectory(anchor('db1'))
      await t.run('skill SKILL-2')
      assert.equal(resultsFor(mock, 'skill SKILL-2')[1], 'hello-fleet v2 as bob')
    })
  })
})
