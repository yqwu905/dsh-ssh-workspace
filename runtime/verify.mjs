// Runs with the bundled Node. No downloads, npm, user configuration or credentials.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const root = dirname(fileURLToPath(import.meta.url))
const digest = async path => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
try {
  const manifestPath = join(root, 'payload-manifest.json')
  if (await digest(manifestPath) !== process.argv[2]) throw new Error('Manifest checksum mismatch')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.platform !== process.platform || manifest.arch !== process.arch || manifest.nodeVersion !== process.versions.node) throw new Error('Runtime platform/version mismatch')
  const expected = new Set(['payload-manifest.json'])
  for (const file of manifest.files) {
    if (!file.path || file.path.startsWith('/') || file.path.split('/').some(part => !part || part === '.' || part === '..') || expected.has(file.path)) throw new Error('Invalid payload path')
    expected.add(file.path)
    const path = join(root, file.path), info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== file.mode || await digest(path) !== file.sha256) throw new Error(`Invalid payload: ${file.path}`)
  }
  async function walk(directory, prefix = '') {
    for (const name of await readdir(directory)) {
      const path = join(directory, name), relative = prefix + name, info = await lstat(path)
      if (info.isDirectory() && !info.isSymbolicLink()) {
        if (info.mode & 0o222) throw new Error(`Writable runtime directory: ${relative}`)
        await walk(path, relative + '/')
      } else if (!expected.delete(relative)) throw new Error(`Unexpected payload: ${relative}`)
    }
  }
  await walk(root)
  if (expected.size) throw new Error('Incomplete payload')
  // Force native add-ons to load now: incompatible libc or missing resources cannot look installed.
  const require = createRequire(import.meta.url)
  require('node-pty')
  require('koffi')
  const systemRoot = dirname(require.resolve(`@deepseek-ai/node-addon-system-${process.platform}-${process.arch}/package.json`))
  require(join(systemRoot, 'bin', process.platform === 'linux' ? 'glibc/system.node' : 'system.node'))
  await import('@deepseek-ai/node-addon-system/flock')
  await import('@deepseek-ai/dsh-fs-sandbox')
  await import('@deepseek-ai/dsh-subprocess-local')
  await import('@deepseek-ai/dsh-sandbox-local')
  if (process.platform === 'linux') {
    const metadata = JSON.parse(await readFile(join(root, 'tools/bubblewrap.json'), 'utf8'))
    const runner = join(root, 'tools/bin/bwrap')
    if (metadata.target !== `linux-${process.arch}` || await digest(runner) !== metadata.sha256) throw new Error('Bundled bubblewrap metadata mismatch')
    const version = execFileSync(runner, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    if (version !== `bubblewrap ${metadata.version}`) throw new Error('Bundled bubblewrap cannot run on this server')
    // --version checks the executable/ABI; kernel enforcement is checked by the provider on connection.
  }
  process.stdout.write('DSH_HELPER_READY\n')
} catch (error) {
  process.stderr.write(`Helper verification failed: ${error.message}\n`)
  process.exitCode = 1
}
