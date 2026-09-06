# Third-Party Notices

## Gradle Wrapper

ModMind bundles the unmodified Gradle Wrapper scripts and JAR from Gradle 9.2.1 so
new and migrated projects can use their pinned Gradle distribution. Gradle is provided
under the Apache License 2.0. Upstream metadata, SHA-256 checksums, and the license are
retained under `vendor/gradle-wrapper`.

- Project: https://github.com/gradle/gradle/tree/v9.2.1
- License: Apache-2.0

## Blockbench

ModMind includes an unmodified offline copy of the official Blockbench Web application.

- Version: 5.1.4
- Upstream commit: `8fe8d9d9568de8233d77cd592744acad495d46b0`
- Project: https://github.com/JannisX11/blockbench
- License: GNU General Public License v3.0 or later

The upstream license, source metadata, build instructions, and file checksums are retained
under `vendor/blockbench`. Distribution of ModMind must preserve these materials and make
the corresponding Blockbench source available as required by its license. The licensing of
the combined distributed application should be reviewed before a public release.

## XMCL Launcher Core

ModMind uses `@xmcl/core` and `@xmcl/installer` for Minecraft metadata parsing,
dependency installation, managed Java runtimes, Fabric installation, and process launch.
It uses `@xmcl/asm` to read legacy Forge annotations from Java class files. The XMCL
packages are provided by the Voxelum project; the ASM port retains the upstream
BSD-3-Clause license and notices.

## HeadlessMC

The optional HeadlessMC smoke-test action downloads the official pinned HeadlessMC launcher
release at first use, verifies its published SHA-256 digest, and stores it in the user's
application-data directory. It is not bundled with ModMind. HeadlessMC is provided under
the MIT License by the HeadlessHQ contributors.

- Version: 2.10.0
- Project: https://github.com/headlesshq/headlessmc
- License: MIT

## ServerPackCreator

The deterministic server-pack synchronization action bundles and invokes the unmodified,
pinned ServerPackCreator CLI release. The application verifies the bundled JAR's SHA-256
before every invocation. Its upstream license and release checksum manifest are retained
under `resources/server-pack-creator`.

- Version: 8.1.2
- Project: https://github.com/Griefed/ServerPackCreator
- Release: https://github.com/Griefed/ServerPackCreator/releases/tag/8.1.2
- License: LGPL-2.1
- Release SHA-256: `6ecb5f604326a8cb74ede15f667d170e2001cd968ab7f99592a0045ff27b0fca`

## extract-zip

ModMind uses `extract-zip` to unpack the verified Gradle distribution. It is provided
under the BSD-2-Clause License.

## electron-updater

ModMind uses `electron-updater` for signed metadata verification, resumable and
differential application downloads, and NSIS update installation. It is provided under
the MIT License by the electron-builder contributors.

- Project: https://github.com/electron-userland/electron-builder
- License: MIT

## React Virtuoso

ModMind uses the unmodified `Virtuoso` React component for viewport-only rendering
of long local conversation timelines. Conversation history remains complete in the
local ConversationStore journal; virtualization only limits mounted DOM nodes.

- Version: 4.18.13
- Project: https://github.com/petyosi/react-virtuoso
- License: MIT

## proper-lockfile

ModMind uses `proper-lockfile` for the advisory inter-process lock around each
append-only conversation journal. The package is used without source changes.

- Version: 4.1.2
- Project: https://github.com/moxystudio/node-proper-lockfile
- License: MIT

## OpenCode and Roo Code storage patterns

The conversation journal adapter follows the upstream append/reconcile conventions
used by OpenCode and Roo Code. No upstream runtime is bundled; the local adapter is
limited to the project storage boundary and keeps this application's existing types.

- OpenCode: https://github.com/anomalyco/opencode (MIT)
- Roo Code: https://github.com/RooCodeInc/Roo-Code (Apache-2.0)

## smol-toml

ModMind uses `smol-toml` to parse Forge and NeoForge mod descriptors according to
the TOML specification. It is provided under the BSD-3-Clause License.

- Project: https://github.com/squirrelchat/smol-toml
- License: BSD-3-Clause

## fzstd

ModMind uses `fzstd` to decompress Zstandard-encoded local Agent requests on
Electron releases whose embedded Node.js runtime does not provide Zstandard.
It is provided under the MIT License by Arjun Barrett.

- Project: https://github.com/101arrowz/fzstd
- License: MIT

## 7zip-bin / 7-Zip

ModMind bundles the `7za` executable from `7zip-bin` for importing common project
archives, including 7z, RAR, CAB, ISO, and compressed TAR variants. 7-Zip is provided
under the GNU LGPL with the upstream unRAR license restriction where applicable.

- Project: https://www.7-zip.org/
- Binary wrapper: https://github.com/develar/7zip-bin

## ffmpeg-static

ModMind uses `ffmpeg-static` to convert imported audio to OGG Vorbis. The packaged
FFmpeg executable is distributed under GPL-3.0-or-later. Its license and build information
are retained beside the executable in the unpacked `node_modules/ffmpeg-static` directory.

- Project: https://github.com/eugeneware/ffmpeg-static
- FFmpeg: https://ffmpeg.org/
- License: GPL-3.0-or-later

## mappings.dev

ModMind can query class and member mapping pages from https://mappings.dev at runtime.
Downloaded indexes and pages are stored as a local cache and are not bundled with the
application. Mapping licenses for each Minecraft version are linked by the upstream site.

## Image Processing

ModMind uses `sharp` for local image decoding, resizing, and nearest-neighbor fallback
processing. Sharp is distributed under the Apache-2.0 license.

ModMind uses React Flow (`@xyflow/react`) for the image workflow canvas under the MIT
license.

ModMind bundles miniPaint v4.14.3 as the embedded manual image editor under the MIT
license. The upstream license, source metadata, archive checksum, and bundled browser
assets are retained under `resources/renderer-public/minipaint`.

- Project: https://github.com/viliusle/miniPaint
- License: MIT

The background-removal action detects and removes a solid background color using the
bundled `sharp` package. It does not perform semantic (AI-based) subject removal.

ModMind includes an embedded TypeScript implementation of the grid detection, refinement,
and sampling algorithm from `perfect-pixel` 0.1.x. The upstream project is MIT licensed.
The embedded implementation is compiled into the application and does not require the
upstream Python package or a separate runtime on the user's machine.

- Project: https://github.com/theamusing/perfectPixel
- License: MIT

## FTB Quests Editor

ModMind uses `ftbq-nbt` to parse and serialize legacy FTB Quests SNBT task books, and
`json5` to read modern JSON5 task books. Both packages are provided under the MIT License.

- ftbq-nbt: https://github.com/Krutoy242/ftbq-nbt
- json5: https://github.com/json5/json5

## AionUi Agent Conversation UI

ModMind's Agent workbench conversation surface is adapted from AionUi's
`ChatLayout`, `MessageList`, `MessageText`, `MessageThinking`,
`MessageToolGroupSummary`, `ConversationPlanBar`, `ThoughtDisplay`, and
`SendBox` components at commit `4f7da7e7243f7696ddb7a558d8187a1803c157b6`.
The copied layout hierarchy and styling are wired to ModMind's existing React
components and Agent event protocol. No AionUi runtime, account, database, or
design-system dependency is bundled.

- Project: https://github.com/iOfficeAI/AionUi
- Copyright: 2025 AionUi (aionui.com)
- License: Apache-2.0
