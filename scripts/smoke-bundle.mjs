import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const entryPoints = [
  '../lib/index.js',
  '../lib/fs.js',
  '../lib/sandbox.js',
  '../lib/subprocess.js',
  '../lib/local-pwsh-subprocess.js',
  '../lib/directory-picker.js',
  '../lib/workspaces.js',
]

await Promise.all(entryPoints.map(path => import(new URL(path, import.meta.url))))
const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
if (!client.includes('window.__ModuleLoader__.load({ id: "dsh-ssh-workspace"')) {
  throw new Error('client bundle does not register with the DSH module loader')
}
new Function(client)

const launchers = [
  ['landlock-run-linux-x64', 'a752bc72f111fcc573c3e61fb90fa544541dac0ca498d2e279e1630d7c659b31'],
  ['landlock-run-linux-arm64', 'f6ae2ad5893e3123f45329ade5518b33c3ac3b102978001ff1c6a6a8ebe2ad9b'],
]
for (const [name, expected] of launchers) {
  const payload = await readFile(new URL(`../assets/${name}`, import.meta.url))
  const actual = createHash('sha256').update(payload).digest('hex')
  if (actual !== expected) throw new Error(`${name} failed its SHA-256 integrity check`)
}
process.stdout.write('built bundle entry points loaded successfully\n')
