const entryPoints = [
  '../lib/index.js',
  '../lib/fs.js',
  '../lib/subprocess.js',
  '../lib/local-pwsh-subprocess.js',
  '../lib/directory-picker.js',
  '../lib/workspaces.js',
]

await Promise.all(entryPoints.map(path => import(new URL(path, import.meta.url))))
const client = await (await import('node:fs/promises')).readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
if (!client.includes('window.__ModuleLoader__.load({ id: "dsh-ssh-workspace"')) {
  throw new Error('client bundle does not register with the DSH module loader')
}
new Function(client)
process.stdout.write('built bundle entry points loaded successfully\n')
