#!/usr/bin/env python3
"""Rebuild pinned static PIE runners; no downloads or system package changes."""
import argparse
import hashlib
import io
import json
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--zig', required=True, type=Path)
parser.add_argument('--target', choices=['linux-x64', 'linux-arm64'])
parser.add_argument('--check', action='store_true', help='Verify byte-for-byte reproducibility without replacing artifacts')
args = parser.parse_args()
zig = args.zig.resolve()
vendor = Path(__file__).resolve().parent.parent / 'runtime/vendor/bubblewrap'
manifest = json.loads((vendor / 'manifest.json').read_text())
assert subprocess.check_output([zig, 'version'], text=True).strip() == manifest['toolchain']['version'], 'Wrong Zig version'


def checked(path, sha256):
    content = path.read_bytes()
    if hashlib.sha256(content).hexdigest() != sha256:
        raise ValueError(f'Input checksum mismatch: {path}')
    return content


for target in ([args.target] if args.target else ['linux-x64', 'linux-arm64']):
    arch = {'linux-x64': 'x86_64', 'linux-arm64': 'aarch64'}[target]
    with tempfile.TemporaryDirectory(prefix='dsh-bwrap-build-') as temporary:
        root = Path(temporary)
        archive = checked(vendor / manifest['source']['file'], manifest['source']['sha256'])
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(root, filter='data')
        source = root / ('bubblewrap-' + manifest['version'])
        sdk = root / 'sdk' / arch
        for item in manifest['sdk']:
            if item['arch'] != arch:
                continue
            content = checked(vendor / item['file'], item['sha256'])
            # APK v2 is concatenated gzip/tar members. Read all members but
            # materialize only these two pinned regular files; no install scripts.
            with tarfile.open(fileobj=io.BytesIO(content), mode='r:gz', ignore_zeros=True) as tar:
                for name in ['usr/include/sys/capability.h', 'usr/lib/libcap.a']:
                    try:
                        entry = tar.getmember(name)
                    except KeyError:
                        continue
                    assert entry.isfile(), 'Unexpected SDK link or special file'
                    path = sdk / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(tar.extractfile(entry).read())
        # Matches upstream Meson's config with selinux/debug_logging disabled
        # and assume_kernel unset. No upstream C code is patched.
        (source / 'config.h').write_text('#define PACKAGE_STRING "bubblewrap ' + manifest['version'] + '"\n')
        binary = root / 'bwrap'
        subprocess.run([
            str(zig), 'cc', '-target', arch + '-linux-musl', '-O2', '-static-pie', '-fPIE',
            '-fstack-protector-strong', '-D_FORTIFY_SOURCE=2', '-D_GNU_SOURCE',
            '-Wl,-z,relro,-z,now', '-s', '-I.', '-I' + str(sdk / 'usr/include'),
            '-ffile-prefix-map=' + str(root) + '=.',
            'bubblewrap.c', 'bind-mount.c', 'network.c', 'utils.c', 'chroot_realpath.c', 'safe_openat.c',
            str(sdk / 'usr/lib/libcap.a'), '-o', str(binary),
        ], cwd=source, check=True)
        digest = hashlib.sha256(binary.read_bytes()).hexdigest()
        if args.check:
            assert digest == manifest['binaries'][target]['sha256'], f'{target}: build differs: {digest}'
        else:
            shutil.copyfile(binary, vendor / target / 'bwrap')
            (vendor / target / 'bwrap').chmod(0o755)
            manifest['binaries'][target] = {'sha256': digest, 'bytes': binary.stat().st_size}
        print(target, digest, flush=True)
if not args.check:
    (vendor / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
