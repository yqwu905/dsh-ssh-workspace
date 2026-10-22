import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { SANDBOX_UNAVAILABLE, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import { checkSandbox, sandboxError } from '../src/sandbox-diagnostics.js'

test('SSH wrapping is collapsed while error code, cause and execution location survive', () => {
  const policy = { mode: 'workspace-write' as const, workspaceRoot: '/data/project' }
  const inner = new SandboxUnavailableError(policy.mode)
  const wrapped = new SandboxUnavailableError(policy.mode, inner.message)
  const result = sandboxError(wrapped, policy, 'SSH server gpu (remote workspace /data/project)')
  assert.ok(result instanceof SandboxUnavailableError)
  assert.equal(result.code, SANDBOX_UNAVAILABLE)
  assert.equal(result.cause, wrapped)
  assert.match(result.message, /SSH server gpu.*remote workspace \/data\/project/u)
  assert.match(result.message, /workspace-write/u)
  assert.doesNotMatch(result.message, /Runner failure:|otherwise switch the consumer/u)
  assert.equal(sandboxError(result, policy, 'another context'), result)
  const failure = sandboxError(new SandboxUnavailableError(policy.mode, 'bwrap: Operation not permitted'), policy, 'DSH Host')
  assert.ok(failure instanceof Error)
  assert.match(failure.message, /Detail: bwrap: Operation not permitted/u)
})

test('unrelated failures and cancellation retain their original identity', () => {
  for (const error of [new Error('Connection closed'), new DOMException('Cancelled', 'AbortError')]) {
    assert.equal(sandboxError(error, { mode: 'read-only', workspaceRoot: '/' }, 'DSH Host'), error)
  }
})

test('preflight asks only for read-only confinement and retains partial enforcement', async () => {
  let calls = 0
  const result = await checkSandbox({ async confine(argv, policy, signal) {
    calls++
    assert.deepEqual(argv, ['/bin/true'])
    assert.deepEqual(policy, { mode: 'read-only', workspaceRoot: '/' })
    assert.ok(signal instanceof AbortSignal)
    return { argv: ['/runtime/landlock-run', '--', ...argv], enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] }
  } }, '/', 'SSH server gpu')
  assert.equal(calls, 1)
  assert.equal(result.status, 'selected')
  assert.equal(result.backend, 'landlock-run')
  assert.equal(result.enforcement, 'partial')
  assert.match(result.message, /still requires runtime enforcement/u)
})

test('preflight failure is diagnostic data and never retries with a wider policy', async () => {
  let calls = 0
  const result = await checkSandbox({ async confine(_argv, policy) {
    calls++
    assert.equal(policy.mode, 'read-only')
    throw new SandboxUnavailableError(policy.mode)
  } }, '/', 'SSH server gpu')
  assert.equal(calls, 1)
  assert.equal(result.status, 'unavailable')
  assert.match(result.message, /SSH server gpu/u)
})

test('an unresponsive provider cannot hold connection setup indefinitely', async () => {
  let signal: AbortSignal | undefined
  const check = checkSandbox({ confine(_argv, _policy, received) {
    signal = received
    return new Promise(() => {})
  } }, '/', 'SSH server gpu', 5)
  // Keep the test alive while the production deadline's unref timer runs.
  const [result] = await Promise.all([check, delay(20)])
  assert.equal(signal?.aborted, true)
  assert.equal(result.status, 'error')
  assert.match(result.message, /timed out/u)
})
