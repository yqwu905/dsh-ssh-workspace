import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
// The deployment CLI intentionally uses only runtime built-ins.
import { deploy, inspectArchive, parseArgs, quote } from '../scripts/deploy-helper.mjs';
const run = promisify(execFile);
const FIXTURE = String.raw`
import hashlib, io, json, sys, tarfile
path, variant = sys.argv[1:]
files = {'dsh-ssh-helper': (b'#!/bin/sh\nexit 0\n', 0o755), 'native/system/package.json': (b'{}', 0o644)}
manifest = {'format': 1, 'version': '0.2.1-rc.2', 'commit': 'a'*40, 'dirty': False, 'target': 'node24-linux-x64', 'protocol': 2, 'nodeVersion': 'v24.1.0', 'files': [{'path':p, 'sha256':hashlib.sha256(data).hexdigest(), 'mode':mode} for p,(data,mode) in files.items()]}
if variant == 'hash': manifest['files'][0]['sha256'] = '0'*64
files['manifest.json'] = (json.dumps(manifest).encode(), 0o644)
with tarfile.open(path, 'w:gz') as archive:
    for p,(data,mode) in files.items():
        info = tarfile.TarInfo('dsh-ssh-helper/' + p); info.mode = mode; info.size = len(data)
        archive.addfile(info, io.BytesIO(data))
    if variant == 'traversal':
        info = tarfile.TarInfo('dsh-ssh-helper/../escape'); info.size=1; info.mode=0o644
        archive.addfile(info, io.BytesIO(b'x'))
    if variant == 'backslash':
        info = tarfile.TarInfo('dsh-ssh-helper/a' + chr(92) + 'b'); info.size=1; info.mode=0o644
        archive.addfile(info, io.BytesIO(b'x'))
    if variant == 'link':
        info = tarfile.TarInfo('dsh-ssh-helper/link'); info.type=tarfile.SYMTYPE; info.linkname='/etc/passwd'; info.mode=0o777
        archive.addfile(info)
`;

test('deployment CLI validates aliases, literal quoting and dedicated paths', () => {
  assert.equal(quote("a'b $()"), "'a'\\''b $()'");
  assert.equal(parseArgs(['--help']), null);
  const args = ['--host','gpu-a','--archive','a.tar.gz','--sha256','a'.repeat(64),'--remote-dir','/opt/dsh-helper/0.2.1-rc.2'];
  assert.equal(parseArgs(args).host, 'gpu-a');
  assert.throws(() => parseArgs([...args, '--host', 'other']), /duplicate/);
  assert.throws(() => parseArgs(args.map(x => x === 'gpu-a' ? '-oProxyCommand=x' : x)), /alias/);
  assert.throws(() => parseArgs(args.map(x => x === '/opt/dsh-helper/0.2.1-rc.2' ? '/opt/../etc' : x)), /normalized/);
});

test('helper archive validation rejects traversal, links, backslashes and changed payload metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-deploy-test-'));
  try {
    for (const variant of ['valid','traversal','link','hash','backslash']) {
      const path = join(dir, variant + '.tar.gz');
      await run('python3',['-c',FIXTURE,path,variant]);
      const sha = createHash('sha256').update(await readFile(path)).digest('hex');
      if (variant === 'valid') {
        const result = await inspectArchive(path,sha);
        assert.equal(result.target,'node24-linux-x64');
        assert.equal(result.helperHash.length,64);
        await assert.rejects(inspectArchive(path,'b'.repeat(64)),/Archive SHA-256/);
      } else await assert.rejects(inspectArchive(path,sha));
    }
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('deployment shell installs a validated archive once with literal spaced paths', { skip: process.platform !== 'linux' || process.arch !== 'x64' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-deploy-shell-'));
  const originalPath = process.env.PATH;
  try {
    const bin = join(dir, 'bin');
    await mkdir(bin);
    // Run the exact remote script on an isolated local target, without SSH/network.
    await writeFile(join(bin, 'ssh'), '#!/bin/sh\nwhile [ "$#" -gt 1 ]; do shift; done\nexec /bin/sh -c "$1"\n', { mode: 0o700 });
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    const archive = join(dir, 'helper.tar.gz');
    await run('python3', ['-c', FIXTURE, archive, 'valid']);
    const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
    const remoteDir = join(dir, "directory with 'quote", '0.2.1-rc.2');
    const options = { host: 'test-only', archive, sha256, remoteDir };
    const result = await deploy(options);
    assert.equal(result.helper, `${remoteDir}/dsh-ssh-helper`);
    assert.equal(await readFile(result.helper, 'utf8'), '#!/bin/sh\nexit 0\n');
    assert.deepEqual(await readdir(join(dir, "directory with 'quote")), ['0.2.1-rc.2']);
    await assert.rejects(deploy(options), /already exists/);
    assert.equal(await readFile(result.helper, 'utf8'), '#!/bin/sh\nexit 0\n');
  } finally {
    process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  }
});
