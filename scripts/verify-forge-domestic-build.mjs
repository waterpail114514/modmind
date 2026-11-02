// Real FG6 regression: reject official JSSE handshakes while domestic HTTPS
// remains available. Uses an installed Gradle/JDK and existing dependency cache;
// this is deliberately not reported as a cold-cache or nationwide network test.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createWriteStream, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-forge-domestic-'))
const data = path.join(process.env.APPDATA ?? '', 'modmind')
const javaHome = process.env.MODMIND_QA_JAVA_HOME || path.join(data, 'build-jdks/temurin-17-windows-x64')
const gradle = process.env.MODMIND_QA_GRADLE_HOME || path.join(data, 'gradle-runtime/gradle-8.12.1')
const home = process.env.MODMIND_QA_GRADLE_CACHE || path.join(data, 'gradle-runtime/cache')
const java = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
await Promise.all([fs.access(java), fs.access(path.join(gradle, 'lib'))])
const bundle = path.join(work, 'policy.cjs')
await build({ stdin: { contents: "export { gradleRepositoryArguments } from './src/main/gradleRepositoryPolicy'", resolveDir: root, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' })
const { gradleRepositoryArguments } = createRequire(import.meta.url)(bundle)
const mirrorPom = 'https://bmclapi2.bangbang93.com/maven/net/minecraftforge/gradle/ForgeGradle/6.0.54/ForgeGradle-6.0.54.pom'
const hashResponse = await fetch(mirrorPom + '.sha1', { signal: AbortSignal.timeout(20000) })
assert.equal(hashResponse.status, 200)
const pomHash = (await hashResponse.text()).trim().split(/\s+/)[0]
assert.match(pomHash, /^[a-f0-9]{40}$/i)
await fs.writeFile(path.join(work, 'settings.gradle'), `pluginManagement { repositories { gradlePluginPortal(); maven { url = 'https://maven.minecraftforge.net/' } } }
rootProject.name = 'forge-domestic-regression'
`)
await fs.writeFile(path.join(work, 'build.gradle'), `plugins { id 'java'; id 'net.minecraftforge.gradle' version '6.0.54' }
version = '1.0'; group = 'dev.modmind.qa'
java { toolchain.languageVersion = JavaLanguageVersion.of(17) }
minecraft { mappings channel: 'official', version: '1.20.1' }
repositories { mavenCentral() }
dependencies { minecraft 'net.minecraftforge:forge:1.20.1-47.4.23' }
tasks.register('verifyDomesticPolicy') {
  doLast {
    assert System.getProperty('net.minecraftforge.gradle.check.certs') == 'false'
    def bytes = new URL('${mirrorPom}').openStream().withCloseable { it.bytes }
    assert java.security.MessageDigest.getInstance('SHA-1').digest(bytes).encodeHex().toString() == '${pomHash}'
    // The flag must not disable actual HttpsURLConnection TLS handling.
    try { new URL('https://maven.minecraftforge.net/').openConnection().connect(); throw new GradleException('Official connection unexpectedly allowed') }
    catch (javax.net.ssl.SSLHandshakeException expected) { println('OFFICIAL_TLS_BLOCK_VERIFIED') }
    println('DOMESTIC_HTTPS_HASH_VERIFIED')
  }
}
`)
const source = path.join(work, 'src/main/java/dev/modmind/qa/Example.java')
await fs.mkdir(path.dirname(source), { recursive: true })
await fs.writeFile(source, 'package dev.modmind.qa; public class Example { public net.minecraft.world.item.Item item() { return net.minecraft.world.item.Items.DIAMOND; } }')
await fs.writeFile(path.join(work, 'gradle.properties'), 'org.gradle.jvmargs=-Xmx2G\n')
const blocker = path.join(work, 'block-official.gradle')
await fs.writeFile(blocker, `
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLHandshakeException
import java.net.Socket
import java.net.InetAddress
class RejectOfficialTls extends SSLSocketFactory {
  SSLSocketFactory delegate
  void check(String host) {
    if (host in ['maven.minecraftforge.net', 'libraries.minecraft.net', 'piston-meta.mojang.com', 'launchermeta.mojang.com', 'piston-data.mojang.com', 'launcher.mojang.com']) {
      println('BLOCKED_OFFICIAL_TLS ' + host)
      throw new SSLHandshakeException('QA: official TLS deliberately blocked')
    }
  }
  String[] getDefaultCipherSuites() { delegate.defaultCipherSuites }
  String[] getSupportedCipherSuites() { delegate.supportedCipherSuites }
  Socket createSocket(Socket socket, String host, int port, boolean close) { check(host); delegate.createSocket(socket, host, port, close) }
  Socket createSocket(String host, int port) { check(host); delegate.createSocket(host, port) }
  Socket createSocket(String host, int port, InetAddress local, int localPort) { check(host); delegate.createSocket(host, port, local, localPort) }
  Socket createSocket(InetAddress host, int port) { check(host.hostName); delegate.createSocket(host, port) }
  Socket createSocket(InetAddress host, int port, InetAddress local, int localPort) { check(host.hostName); delegate.createSocket(host, port, local, localPort) }
}
def originalFactory = HttpsURLConnection.defaultSSLSocketFactory
HttpsURLConnection.defaultSSLSocketFactory = new RejectOfficialTls(delegate: originalFactory)
gradle.buildFinished { HttpsURLConnection.defaultSSLSocketFactory = originalFactory }
`)
const env = { ...process.env, JAVA_HOME: javaHome, GRADLE_USER_HOME: home,
  JAVA_TOOL_OPTIONS: `-Djdk.net.unixdomain.tmpdir="${path.join(data, 'java-sockets')}" -Dsun.net.client.defaultConnectTimeout=10000 -Dsun.net.client.defaultReadTimeout=20000 -Dorg.gradle.internal.http.connectionTimeout=10000 -Dorg.gradle.internal.http.socketTimeout=20000` }
for (const name of Object.keys(env)) if (/^(?:https?|all)_proxy$/i.test(name)) delete env[name]
async function run(name, policy, tasks, extra = []) {
  const logPath = path.join(work, name + '.log')
  const log = createWriteStream(logPath)
  const start = Date.now()
  const child = spawn(java, ['-classpath', path.join(gradle, 'lib/*'), 'org.gradle.launcher.GradleMain', '-g', home, '--no-daemon', '--console=plain', '--stacktrace', '-I', blocker, ...policy, ...extra, ...tasks], { cwd: work, env, windowsHide: true })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log.write(bytes); output = (output + bytes).slice(-200000) })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  await new Promise(resolve => log.end(resolve))
  const result = { name, code, elapsedMs: Date.now() - start, logPath }
  console.log(JSON.stringify(result))
  return { ...result, output }
}
const report = { work, javaHome, gradle, cache: home, proxyEnvironmentCleared: true, dependencyCacheReused: true, actualCompilation: false, passed: false, runs: [] }
try {
  const baseline = await run('baseline', gradleRepositoryArguments(home), ['help'])
  report.runs.push(baseline)
  assert.notEqual(baseline.code, 0)
  assert.match(baseline.output, /QA: official TLS deliberately blocked/)
  const fixed = await run('fixed', gradleRepositoryArguments(home, false, true), ['verifyDomesticPolicy', 'build'])
  report.runs.push(fixed)
  assert.equal(fixed.code, 0, fixed.output.slice(-6000))
  assert.match(fixed.output, /DOMESTIC_HTTPS_HASH_VERIFIED/)
  assert.match(fixed.output, /OFFICIAL_TLS_BLOCK_VERIFIED/)
  const explicit = await run('explicit-check', gradleRepositoryArguments(home, false, true), ['help'], ['-Dfg.check.certs=true'])
  report.runs.push(explicit)
  assert.notEqual(explicit.code, 0)
  assert.match(explicit.output, /QA: official TLS deliberately blocked/)
  const artifact = path.join(work, 'build/libs/forge-domestic-regression-1.0.jar')
  const bytes = await fs.readFile(artifact)
  report.artifact = { path: artifact, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  report.actualCompilation = true
  report.passed = true
} catch (error) { report.error = String(error.stack ?? error); process.exitCode = 1 }
await fs.writeFile(path.join(work, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ ...report, runs: report.runs.map(({ output, ...run }) => run) }, null, 2))
