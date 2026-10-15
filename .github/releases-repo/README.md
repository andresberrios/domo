# Domo releases

Built releases of Domo, a voice-first
control room for coding agents. This repository holds only the releases and
the install script; it has no source.

## Install

```bash
curl -fsSL https://github.com/andresberrios/domo-releases/releases/latest/download/install.sh | sh
```

Needs Docker, on macOS (Apple silicon or Intel) or Linux (x64 or arm64, glibc).
Domo installs under `~/.domo`, starts at login, and opens
`https://localhost:3666`, where a setup guide takes it from there. It updates
itself from the releases here; see Settings → Updates.

Each release has a tarball per platform, `manifest.json` and `SHA256SUMS`.
The installer and the updater check every download against its checksum.

Copyright (c) Andrés Berrios. All rights reserved.
