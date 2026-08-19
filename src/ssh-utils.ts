import { createHash } from 'node:crypto'
import { posix } from 'node:path'

/** Quote one opaque value as one POSIX shell word. */
export function quoteShell(value: string): string {
  if (value.includes('\0')) throw new Error('dsh-ssh-workspace: shell argument contains NUL')
  return `'${value.replaceAll('\'', `'"'"'`)}'`
}

/** OpenSSH-style SHA-256 fingerprint for a raw SSH host key. */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`
}

/** Normalize accepted fingerprint spelling without weakening the comparison. */
export function normalizeFingerprint(value: string): string {
  const trimmed = value.trim()
  return trimmed.startsWith('SHA256:') ? trimmed : `SHA256:${trimmed}`
}

/** Exact argv + environment + cwd wrapper evaluated by the SSH server's login shell. */
export function buildRemoteCommand(
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>> = {},
): string {
  if (argv.length === 0 || argv[0] === undefined || argv[0].length === 0) {
    throw new Error('dsh-ssh-workspace: argv must contain a non-empty program')
  }
  if (!posix.isAbsolute(cwd)) {
    throw new Error(`dsh-ssh-workspace: remote cwd must be absolute: ${JSON.stringify(cwd)}`)
  }
  const entries = Object.entries(env)
  const tombstones = new Set(entries.filter(([, value]) => value === undefined).map(([name]) => name))
  const explicit = entries
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
        throw new Error(`dsh-ssh-workspace: invalid environment name ${JSON.stringify(name)}`)
      }
      if (value.includes('\0')) {
        throw new Error(`dsh-ssh-workspace: environment value for ${name} contains NUL`)
      }
      return `${name}=${quoteShell(value)}`
    })
  const base = [
    ['HOME', 'HOME="$HOME"'],
    ['PATH', 'PATH="$PATH"'],
    ['USER', 'USER="${USER-}"'],
    ['LOGNAME', 'LOGNAME="${LOGNAME-}"'],
    ['SHELL', 'SHELL="${SHELL-/bin/sh}"'],
    ['LANG', 'LANG="${LANG-C.UTF-8}"'],
    ['LC_ALL', 'LC_ALL="${LC_ALL-}"'],
    ['TZ', 'TZ="${TZ-}"'],
    ['TERM', 'TERM="${TERM-dumb}"'],
    ['HTTP_PROXY', 'HTTP_PROXY="${HTTP_PROXY-}"'],
    ['HTTPS_PROXY', 'HTTPS_PROXY="${HTTPS_PROXY-}"'],
    ['NO_PROXY', 'NO_PROXY="${NO_PROXY-}"'],
  ].filter(([name]) => name !== undefined && !tombstones.has(name)).map(([, assignment]) => assignment)
  const words = argv.map(quoteShell).join(' ')
  return `cd -- ${quoteShell(cwd)} && exec env -i ${[...base, ...explicit].join(' ')} ${words}`
}

/** Resolve once when a caller signal aborts, without leaving a listener behind. */
export function waitForAbort(signal: AbortSignal): Promise<false> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise(resolve => signal.addEventListener('abort', () => resolve(false), { once: true }))
}
