import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import sevenZip from '7zip-bin'

// Match the upstream pins in copyBundledGradleWrapper and vendor/gradle-wrapper/UPSTREAM.txt.
// Verify exact bytes: normalizing during verification would hide broken release assets.
export const gradleWrapperChecksums = {
  gradlew: 'b2fe376b143a459ba5d0bd290dc89beed5399fc6d159cd1214bd642ea94bcf07',
  'gradlew.bat': '9386e790d58b9368ca8e034536a5baa688643d51cb37bfa462503d36fd0291a6',
  'gradle-wrapper.jar': '423cb469ccc0ecc31f0e4e1c309976198ccb734cdcbb7029d4bda0f18f57e8d9'
}

function verifyBytes(bytes, name, location) {
  const expected = gradleWrapperChecksums[name]
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected) {
    throw new Error(`Gradle Wrapper verification failed: ${name} in ${location}; expected ${expected}, got ${actual}. Restore the pinned upstream files and preserve LF line endings for both scripts.`)
  }
  return { name, sha256: actual }
}

export async function verifyGradleWrapperAssets(wrapperRoot) {
  const results = []
  for (const name of Object.keys(gradleWrapperChecksums)) {
    results.push(verifyBytes(await fs.readFile(path.join(wrapperRoot, name)), name, wrapperRoot))
  }
  return results
}

export function verifyInstallerGradleWrapper(installer) {
  // Read the actual embedded payload, not win-unpacked or the current checkout.
  // The NSIS installer contains a 7z payload; -so avoids writing extracted files.
  return Object.keys(gradleWrapperChecksums).map((name) => {
    const result = spawnSync(sevenZip.path7za, [
      'x', '-so', '-bsp0', path.resolve(installer), `resources/gradle-wrapper/${name}`
    ], { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 })
    if (result.error || result.status !== 0) {
      throw new Error(`Cannot verify Gradle Wrapper ${name} in ${installer}: ${result.error?.message ?? result.stderr?.toString().trim() ?? result.status}`)
    }
    return verifyBytes(result.stdout, name, installer)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const wrapperRoot = path.resolve(import.meta.dirname, '../vendor/gradle-wrapper')
  const assets = await verifyGradleWrapperAssets(wrapperRoot)
  process.stdout.write(`${JSON.stringify({ gradleWrapper: 'verified', assets })}\n`)
}
