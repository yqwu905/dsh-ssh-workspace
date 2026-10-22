/** Bounded child processes. Arguments are passed directly; only our quoted remote script uses a shell. */
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { SSH_ALIAS } from './ssh-config.js'

export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
export interface CommandOptions { cwd?: string; input?: string; inputFile?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }
export async function command(executable: string, args: string[], options: CommandOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', failure: Error | undefined
    let force: NodeJS.Timeout | undefined
    const stop = (error: Error) => {
      failure ??= error
      child.kill('SIGTERM')
      force ??= setTimeout(() => child.kill('SIGKILL'), 2000)
      force.unref()
    }
    const timer = setTimeout(() => stop(new Error(`${executable} timed out`)), options.timeoutMs ?? 30_000)
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString('utf8')
      if (stdout.length > 1024 * 1024) stop(new Error(`${executable} output limit exceeded`))
    })
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString('utf8')).slice(-8192) })
    child.once('error', error => { failure = error })
    child.once('close', code => {
      clearTimeout(timer); if (force) clearTimeout(force)
      if (failure) reject(failure)
      else if (code !== 0) reject(new Error(`${executable} failed (${code}): ${stderr.trim() || stdout.trim()}`))
      else resolve(stdout)
    })
    if (options.inputFile) void pipeline(createReadStream(options.inputFile), child.stdin).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') stop(error as Error)
    })
    else { child.stdin.on('error', () => {}); child.stdin.end(options.input) }
  })
}

export function sshCommand(host: string, script: string, options: CommandOptions = {}): Promise<string> {
  if (!SSH_ALIAS.test(host)) throw new Error('Invalid OpenSSH alias')
  return command('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no',
    '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
    // Bootstrap must also work before a ControlMaster exists; do not reuse a stale configured master.
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', host, `sh -c ${shellQuote(script)}`], options)
}
