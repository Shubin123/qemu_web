# QEMU Web

Experimental 32-bit i440fx PC browser host. Uses the validated JIT/x87 engine
from the private `Shubin123/qemu_emscripten` development repository.

Live: https://shubin123.github.io/qemu_web/

Open the hamburger menu to choose a local PC BIOS and optional boot ISO or
raw/qcow2 disk, choose Done, then use the pyramid Start PC button.
Reset menu defaults clears file selections, restores the default choices and
collapses menu sections. It is available when the PC is stopped. Files
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
[Matching complete engine source](https://github.com/Shubin123/qemu_web/releases/download/engine-c5e0265/qemu-emscripten-c5e0265-source.tar.gz)
is provided publicly with the binary, including the offline pinned source
bundle, patches, build scripts and dependency sources. Rebuild instructions
are in its README. Engine source version: `c5e0265`; Emscripten: `6.0.9`.

The guest architecture dropdown lists Intel/AMD 32-bit, Intel/AMD 64-bit and
ARM 64-bit. Only Intel/AMD 32-bit can start: this bundle has no validated
64-bit or ARM guest engine. This choice describes the emulated CPU; it does
not need to match the browser host CPU. The validated runtime and its hashes
are unchanged.

The OS menu and coverage table include FreeDOS, Alpine, Debian 12, Ubuntu
24.04, Fedora, Windows 11 and TempleOS. None has passed a full OS acceptance
test on this bundle. Selecting a name does not download or install that OS.
The current machine has at most 128 MiB RAM, no VGA option ROM input, and no
networking or audio. Modern desktop OS compatibility is not established.
TempleOS cannot be the default until an x86-64 engine and boot test pass.

For repeatable browser OS tests, copy `tests/os-plan.example.json` to the
ignored `tests/os.local.json`, replace the paths and checkpoints for each
local OS/version, and run:

```sh
npm run test:os -- tests/os.local.json
```

The example is an unverified test plan, not a result. It assumes boot media
already configured to send its console to COM1 (`console=ttyS0` for Linux).
The BIOS, media and OS configuration must be compatible with the selected
machine. Each case must reach a console checkpoint and respond to keyboard
input. The runner exercises the actual form, records browser version, engine
hash, firmware/media hashes, console output and checkpoints under ignored
`tests/artifacts/os-results.json`, and fails on missing checkpoints or
unsupported architectures. These checks establish only the named version
and workflow; they do not verify desktop applications or every OS feature.
`test:browser` also runs a generated-firmware self-test of this runner;
its separate report is not OS compatibility evidence. No OS images or BIOS
files belong in Git. A future engine import must include matching validated
runtime modules, hashes and source provenance.
