import { writeFile } from 'node:fs/promises'
import { build } from 'esbuild'

await build({
  entryPoints: {
    index: 'src/index.ts',
    fs: 'src/fs.ts',
    sandbox: 'src/sandbox.ts',
    subprocess: 'src/subprocess.ts',
    'local-pwsh-subprocess': 'src/local-pwsh-subprocess.ts',
    'directory-picker': 'src/directory-picker.ts',
    workspaces: 'src/workspaces.ts',
  },
  outdir: 'lib',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'none',
  // ssh2 is CommonJS and contains guarded/dynamic requires. Give esbuild's
  // ESM compatibility helper the CommonJS globals its modules expect.
  banner: {
    js: [
      "import { createRequire as __dshCreateRequire } from 'node:module';",
      "import { fileURLToPath as __dshFileURLToPath } from 'node:url';",
      "import { dirname as __dshDirname } from 'node:path';",
      'const require = __dshCreateRequire(import.meta.url);',
      'const __filename = __dshFileURLToPath(import.meta.url);',
      'const __dirname = __dshDirname(__filename);',
    ].join(' '),
  },
  external: [
    '@deepseek-ai/*',
    // ssh2 deliberately treats these native accelerators as optional.
    // Its pure-JS/Node-crypto path catches the missing requires at runtime.
    'cpu-features',
    './crypto/build/Release/sshcrypto.node',
  ],
})

const client = await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  write: false,
  legalComments: 'none',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/*'],
})
const body = client.outputFiles[0]?.text
if (body === undefined) throw new Error('client bundle produced no JavaScript output')
const wrapped = [
  'window.__ModuleLoader__.load({ id: "dsh-ssh-workspace", factory: (require) => {',
  'var module = { exports: {} }; var exports = module.exports;',
  body,
  'return module.exports; } });',
  '',
].join('\n')
await writeFile('lib/client.js', wrapped)
