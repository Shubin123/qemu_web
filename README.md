# QEMU Web

Experimental 32-bit i440fx PC browser host. Uses the validated JIT/x87 engine
from the private `Shubin123/qemu_emscripten` development repository.

Choose a local PC BIOS and optional raw/qcow2 disk, then start the PC. Files
are never uploaded. Keyboard input is captured while the display has focus.
Disk changes are discarded on stop. No guest firmware or operating systems
are included or downloaded. Audio, networking and x86-64 are not available.

```sh
npm ci
npm run build
npm test
npm run test:browser
npm start
```

The server supplies cross-origin isolation headers for Wasm threads. Static
hosting uses the included service worker and reloads once to enable isolation.
`web/` is generated from `app/` plus the checked, hash-pinned `runtime/`.

GPL-2.0-or-later; see LICENSE. The runtime preserves its QEMU/xemu ancestry.
[Matching complete engine source](https://github.com/Shubin123/qemu_web/releases/download/engine-5718b2d/qemu-emscripten-5718b2d-source.tar.gz)
is provided publicly with the binary, including the offline pinned source
bundle, patches, build scripts and dependency sources. Rebuild instructions
are in its README. Engine source version: `5718b2d`; Emscripten: `6.0.9`.
