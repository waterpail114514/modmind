# Minecraft server plugin starter provenance

The Bukkit and Velocity lifecycle skeletons are vendored from Minecraft Development,
the IntelliJ plugin recommended by Paper's official project setup documentation.

- Repository: https://github.com/minecraft-dev/MinecraftDev
- Pinned revision: dec3e63ba62b9f6aaea5ad6a21bc011fe087b08c
- Exact paths and SHA-256: upstream.json
- License: LGPL-3.0; both LGPL and incorporated GPL text are included.
- Regenerate embedded strings: `node scripts/sync-plugin-starter-assets.mjs`.

ModMind adds a minimal status command, enable/disable logging, generated Velocity
version constants and exact API/toolchain selection. No scheduler, executor,
database pool, static singleton or third-party runtime library is created by the
starter. Generated projects retain template source attribution and license files.

The upstream Velocity V2 template is retained as provenance only. Published
Velocity 3.4.0, 3.5.1 and 4.1.1 artifacts use `event.proxy`, which real compilation
confirmed. Never map an upstream template label to a platform major without
checking the API.

Other reviewed sources: PaperMC official project setup (Gradle compileOnly,
toolchain and repository guidance); flytegg/paper-plugin-template at
d5e95b613d4411b75bcf1af7b4a3272342bdcb2c (MIT). The latter is Kotlin/Paper 1.20.2
and includes a static plugin singleton and additional frameworks, so it is not
used as the universal starter.
