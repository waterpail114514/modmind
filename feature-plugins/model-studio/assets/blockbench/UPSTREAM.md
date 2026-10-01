# Blockbench Web Distribution

This directory contains an unmodified snapshot of the official Blockbench web
distribution.

- Project: Blockbench
- Upstream: https://github.com/JannisX11/blockbench
- Official web distribution: https://web.blockbench.net/
- Version: 5.1.4
- Git tag: v5.1.4
- Git commit: `8fe8d9d9568de8233d77cd592744acad495d46b0`
- License: GPL-3.0-or-later (see `LICENSE.md`)
- Local entry point: `index.html`
- Main web bundle: `dist/bundle.js`

The snapshot was retrieved from the official web distribution on 2026-07-14.
The version embedded in `dist/bundle.js` and the upstream package metadata both
report 5.1.4.

Core file SHA-256 checksums:

```text
index.html      E2C3158F9F34997DB656D06A7BDEAC4BC2A8C7388BB3924ADD3C8B73E15B49FA
dist/bundle.js  7D36838C41B2ED78D7881680DBA68E9FF7A1239026CC6FD711F84BE4FDCC39E8
LICENSE.md      8B1BA204BB69A0ADE2BFCF65EF294A920F6BB361B317DBA43C7EF29D96332B9B
```

The exact corresponding source is available at:

https://github.com/JannisX11/blockbench/tree/8fe8d9d9568de8233d77cd592744acad495d46b0

The upstream web build command is `npm run build-web`. It runs
`node ./build.js --target=web` and emits `dist/bundle.js`; `index.html`, CSS,
fonts, assets, and `lib/gif.worker.js` are runtime files alongside that bundle.

Do not remove `LICENSE.md`, this notice, the upstream README, or the upstream
package metadata when redistributing this directory.
