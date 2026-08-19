import { build } from 'esbuild'

await build({
  entryPoints: {
    index: 'src/index.ts',
    fs: 'src/fs.ts',
    subprocess: 'src/subprocess.ts',
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
