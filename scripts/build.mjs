import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('lib', { recursive: true });
await build({ entryPoints: ['src/index.ts'], outfile: 'lib/index.js', bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', sourcemap: true });
const result = await build({ entryPoints: ['src/client.tsx'], bundle: true, platform: 'browser', format: 'cjs', target: 'es2022', external: ['react', 'react/jsx-runtime', 'react-dom'], write: false });
await writeFile('lib/client.js', `window.__ModuleLoader__.load({id:"dsh-ssh-workspaces",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${result.outputFiles[0].text}\nreturn module.exports;}});\n`);
