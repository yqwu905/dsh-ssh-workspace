const entryPoints = [
  '../lib/index.js',
  '../lib/fs.js',
  '../lib/subprocess.js',
  '../lib/directory-picker.js',
  '../lib/workspaces.js',
]

await Promise.all(entryPoints.map(path => import(new URL(path, import.meta.url))))
process.stdout.write('built bundle entry points loaded successfully\n')
