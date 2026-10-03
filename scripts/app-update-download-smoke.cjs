// Run after packaging: npx electron scripts/app-update-download-smoke.cjs
// Uses the packaged config and real electron-updater HTTP/hash/cache code.
// All requests go to a loopback fixture; no installer is executed.
const { app } = require('electron')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { promises: fs } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { NsisUpdater } = require('electron-updater/out/NsisUpdater')
const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor')
const { stringify } = require('yaml')

let root, server
async function run() {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-update-download-'))
  app.setPath('userData', path.join(root, 'electron-profile'))
  await app.whenReady()
  const configPath = path.resolve(__dirname, '../release/win-unpacked/resources/app-update.yml')
  await fs.access(configPath)
  const bytes = Buffer.alloc(10 * 1024 * 1024 + 1, 37)
  const digest = createHash('sha512').update(bytes).digest('base64')
  const requests = []
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost')
    requests.push(url.pathname)
    if (url.pathname.endsWith('/latest.yml')) {
      const brokenHash = url.pathname.startsWith('/bad-hash/')
      response.end(stringify({ version: '1.4.17', files: [{ url: 'fixture.exe', size: bytes.length,
        sha512: brokenHash ? createHash('sha512').update('incorrect').digest('base64') : digest }],
      releaseDate: '2026-10-03T00:00:00.000Z' }))
    } else if (url.pathname.endsWith('/fixture.exe')) {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length })
      response.end(bytes)
    } else { response.writeHead(404); response.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/`
  const results = []
  for (const scenario of ['success', 'bad-hash', 'missing-config']) {
    const cache = path.join(root, scenario, 'cache')
    const updater = new NsisUpdater(null, {
      version: '1.4.16', name: 'modmind', isPackaged: true,
      appUpdateConfigPath: scenario === 'missing-config' ? path.join(root, 'missing-app-update.yml') : configPath,
      userDataPath: path.join(root, scenario, 'profile'), baseCachePath: cache,
      whenReady: async () => {}, onQuit: () => {}, quit: () => { throw new Error('Must not install in smoke test') }
    })
    updater.httpExecutor = new ElectronHttpExecutor()
    updater.logger = null
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.disableDifferentialDownload = true
    updater.setFeedURL({ provider: 'generic', url: `${base}${scenario}/`, useMultipleRangeRequest: false })
    const checked = await updater.checkForUpdates()
    assert.equal(checked.isUpdateAvailable, true)
    if (scenario === 'success') {
      const [file] = await updater.downloadUpdate()
      assert.equal(path.dirname(file), path.join(cache, 'modmind-updater/pending'))
      assert.deepEqual(await fs.readFile(file), bytes)
      results.push({ scenario, status: 'downloaded-and-verified', bytes: bytes.length })
    } else if (scenario === 'bad-hash') {
      await assert.rejects(updater.downloadUpdate(), /checksum mismatch/i)
      results.push({ scenario, status: 'rejected' })
    } else {
      await assert.rejects(updater.downloadUpdate(), { code: 'ENOENT' })
      assert.equal(requests.includes('/missing-config/fixture.exe'), false)
      results.push({ scenario, status: 'reproduced-original-failure-before-download' })
    }
  }
  console.log(JSON.stringify({ configPath, results }, null, 2))
}

run().then(async () => {
  if (server) await new Promise(resolve => server.close(resolve))
  // Electron may still hold its profile; retain the temp fixture for OS cleanup.
  app.exit(0)
}, async error => {
  console.error(error)
  if (server) server.close()
  app.exit(1)
})
