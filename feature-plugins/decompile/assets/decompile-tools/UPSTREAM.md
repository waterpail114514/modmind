# Bundled decompile / remap tools

ModMind bundles the following unmodified Maven Central / FabricMC Maven release
artifacts for the controlled JAR decompilation feature. All jars are verified
against `checksums.txt` (SHA-256) before execution.

## Vineflower (decompiler)

- Project: https://github.com/Vineflower/vineflower
- Artifact: `org.vineflower:vineflower:1.11.1` (Maven Central)
- Size: 1,847,869 bytes
- SHA-256: `a615d07ddbbcd489369674f40e42df639c32be95410890b38f173d5c1e2ea39c`
- License: Apache-2.0 (per upstream POM; earlier MIT claim was incorrect)

## tiny-remapper (Fabric intermediary remapper)

- Project: https://github.com/FabricMC/tiny-remapper
- Artifact: `net.fabricmc:tiny-remapper:0.14.0` (FabricMC Maven)
- Size: 242,319 bytes
- SHA-256: `0a86f606ca086bd7f90cededa884d23d014696a7d97a8bedc159f9efc5e6026a`
- License: Apache-2.0

Dependencies of tiny-remapper, bundled alongside so it can run with `-cp`:

| Artifact | SHA-256 | License |
|---|---|---|
| `org.ow2.asm:asm:9.9.1` | `6f3828a215c920059a5efa2fb55c233d6c54ec5cadca99ce1b1bdd10077c7ddd` | BSD-3-Clause |
| `org.ow2.asm:asm-commons:9.9.1` | `c2319e014ce7199f2b7f7d56d6bb991863168c3f4b6cd6c9f542a4937ef7ef88` | BSD-3-Clause |
| `org.ow2.asm:asm-tree:9.9.1` | `0f3555096b720b820bbacab0b515589bee0200bee099bda14c561738ae837ba1` | BSD-3-Clause |
| `org.ow2.asm:asm-util:9.9.1` | `c5ebbbeaf68126af094b42fa4800f59bc4413abd02d95b9aefad722cd257e207` | BSD-3-Clause |
| `net.fabricmc:mapping-io:0.7.1` | `1419e8ee795ca3cf86f707a6a2f10e613257e9c1ce91a1101602c07b7cff7a48` | Apache-2.0 |

`checksums.txt` lists the SHA-256 of every jar in this directory. Upstream
license texts are collected in `LICENSE` (Apache-2.0) and `LICENSE-bsd-asm.txt` (ASM BSD).
