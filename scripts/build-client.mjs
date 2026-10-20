// Build client/src into client/dist/client.js in the DSH browser-plugin
// format: a CommonJS factory registered through window.__ModuleLoader__,
// with the shell's shared platform modules left external.
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
// Shared module table of @deepseek-ai/dsh-client-web (PLATFORM_MODULES).
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', 'zod',
  '@tanstack/react-virtual', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
]

const result = await build({
  entryPoints: [join(root, 'client/src/index.jsx')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: PLATFORM_MODULES,
  legalComments: 'none',
  charset: 'utf8',
})
const body = result.outputFiles[0].text
const wrapped = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${body}
\t\treturn module.exports;
\t}
});
`
await mkdir(join(root, 'client/dist'), { recursive: true })
await writeFile(join(root, 'client/dist/client.js'), wrapped)
console.log(`client/dist/client.js ${wrapped.length} bytes`)
