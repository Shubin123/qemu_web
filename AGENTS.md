This repository owns the general i386 PC browser UI. The sibling
qemu_emscripten owns the engine and offline source bundle. Import only a
validated core and its matching runtime modules; preserve runtime hashes.
Run npm run build, npm test and npm run test:browser after changes.
Never commit guest BIOS, disk images or save states. Tests generate firmware.
Preserve upstream licenses. Publication requires an explicit user request.
