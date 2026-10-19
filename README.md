# QEMU Web

Experimental 32-bit i440fx PC browser host. Uses the validated JIT/x87 engine
from the private `Shubin123/qemu_emscripten` development repository.

Live: https://shubin123.github.io/qemu_web/

Open the hamburger menu to choose a local PC BIOS and optional boot ISO or
raw/qcow2 disk, choose Done, then use the pyramid Start PC button.
Reset menu defaults clears file selections, restores the default choices and
collapses menu sections. It is available when the PC is stopped. Files
are never uploaded. Keyboard input is captured while the display has focus.
Unsaved disk changes are discarded on stop; Save current session preserves private changes in browser storage. No guest firmware or operating systems
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
[Matching engine source](https://github.com/Shubin123/qemu_web/releases/download/engine-99be56e/qemu-emscripten-99be56e-source.tar.gz)
contains the offline pinned source bundle, patches, build scripts and dependency
sources for `99be56e`. `runtime/runtime.json` records the exact engine commit,
vendor tree and binary hashes. Emscripten: `6.0.9`.

The guest CPU does not need to match the browser host CPU.

The OS menu and coverage table include FreeDOS, Alpine, Debian 12, Ubuntu
24.04, Fedora, Windows 11 and TempleOS. None has passed a full OS acceptance
test on this bundle. Selecting a name does not download or install that OS.
The widget offers memory settings up to 3072 MiB, subject to the selected core
and browser limits, and bundled PC firmware. Networking and audio are not
available. Modern desktop OS compatibility is not established.

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

### Browser startup controls

The Boot Media widget offers **Resume saved session if available** and
**Fresh boot using cached files**. Keep **Keep boot files in this browser**
enabled to retain the ISO, extracted kernel/initramfs and verified engine binary.
The first start still boots the guest normally. **Save current session** can
checkpoint a long boot or running desktop; saves happen only on request. Later starts can reuse cached media
without selecting the ISO again. **Clear all cached systems and saves** removes
this local data while the PC is stopped.

Saves are matched to the exact engine, media, firmware, memory and boot profile.
A mismatch starts fresh. Failed saves preserve the last completed checkpoint.
Files and saved RAM stay in this browser profile and origin, using OPFS; allow
space for the ISO and saved/working guest memory. Raw and self-contained qcow2 disks use private overlays, so checkpoints
include disk writes while the selected source image stays unchanged. Each
OS/architecture selection has its own checkpoint. Use **Start cached system**
to start without reselecting files. Clear removes all saved systems. Browser storage eviction may remove
cached data. Generated-firmware tests cover the save/reload/restore mechanism;
a full CachyOS desktop resume has not been validated.

The published runtime and matching source archive identify engine commit
`99be56ee75aa704e68a281ea19c798bf86c6ee23`. Browser checkpoints remain local and are never published.
