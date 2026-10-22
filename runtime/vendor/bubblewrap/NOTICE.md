# Bundled bubblewrap 0.13.1

The Linux x64 and arm64 executables are built from the unmodified upstream
0.13.1 release sources, with Zig 0.15.2's musl toolchain and Alpine libcap 2.78-r1
static libraries. They are static PIE executables: no system dynamic loader,
glibc, libcap.so, package manager, root installation or setuid bit is required.
The upstream `assume_kernel` option is left unset, retaining old-kernel fallback
code. Kernel features and the surrounding container's restrictions still apply.

`manifest.json` records exact SHA-256 digests, provenance URLs and build inputs.
The official upstream source archive and the exact libcap SDK APKs are included
under `source/`. APK control checksums were compared to the official Alpine
index, and their control records' data hashes were verified before extraction.
These are not Alpine's prebuilt bubblewrap binaries: those currently compile
out fallback code for kernels older than 6.18.

Rebuild with `python3 scripts/build-bubblewrap.py --zig /path/to/zig --check`
from the repository. This requires Zig 0.15.2 and Python 3.12+, only on the build
machine. Ordinary plugin/helper installation uses the supplied executables and
does not compile anything remotely. The script is also included in the plugin
package. The toolchain archive SHA-256 is recorded in the manifest; download it
from the recorded official URL and check that digest before executing it.

Licenses: bubblewrap is LGPL-2.1-or-later (`LICENSE-bubblewrap`); musl is MIT with
the additional notices in `LICENSE-musl`; libcap is distributed under its BSD
3-clause option (`LICENSE-libcap`). Zig's runtime code is MIT (`LICENSE-zig`). The complete bubblewrap and libcap sources
retain their authors' copyright notices and are shipped alongside this notice.
These licenses apply to the bundled components independently of the plugin's
MIT license. You may rebuild and replace these components; update the pinned
manifest digests accordingly before preparing a new helper payload.

The adapter in `src/helper-sandbox.ts` changes only the pinned DSH provider's
bwrap discovery and executable path. It probes the bundled runner, then an
existing system bwrap if available, using the original DSH read-only profile.
The upstream Landlock fallback, sandbox modes and enforcement metadata remain
unchanged. The selected bwrap path is absolute, so a tool's PATH cannot replace
the probed executable when the command starts. macOS keeps native sandbox-exec.
