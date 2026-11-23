import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { fixtureScript, scenarioScript } from './common.mjs'

const dist = resolve(process.env.LOFOLD_READER_DIST ?? fileURLToPath(new URL('../../dist/', import.meta.url)))
const artifacts = resolve(process.env.LOFOLD_READER_ARTIFACTS ??
  fileURLToPath(new URL('../../../../target/reader-layout/', import.meta.url)), 'chromium')
const origin = 'http://127.0.0.1:14200'
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}
const messageCases = ['alert', 'legacy', 'data-table', 'media', 'fields', 'fallback']
const matrix = [
  ...messageCases.flatMap(name => [420, 1200].flatMap(width => ['white', 'gold'].map(theme => [
    name, width, theme, width === 1200 && theme === 'gold' && (name === 'alert' || name === 'data-table'),
  ]))),
  ['legacy', 320, 'gold'],
  ['attachments', 420, 'gold'],
  ['attachments', 835, 'white'],
  ['attachments', 966, 'white'],
  ['attachments', 1512, 'gold'],
  ...[320, 420, 760, 761, 965, 966, 1200, 1512].map((width, i) => [
    'workspace', width, i % 2 === 0 ? 'gold' : 'white',
  ]),
]
const only = process.env.LOFOLD_READER_SCENARIO
const selected = only ? matrix.filter(item => item[0] === only) : matrix
assert(selected.length > 0, 'Unknown LOFOLD_READER_SCENARIO: ' + only)
await readFile(join(dist, 'index.html'))
await mkdir(artifacts, { recursive: true })

// Requests are fulfilled from production dist in memory. The tests neither
// start a public server nor pass browser requests through to the network.
async function attachLocalRoutes(context, unexpectedRequests) {
  await context.routeWebSocket('**/*', socket => {
    unexpectedRequests.push(socket.url())
    socket.close()
  })
  await context.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = resolve(dist, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))
    const contentType = mimeTypes[extname(path)]
    if (url.origin !== origin || request.method() !== 'GET' || !path.startsWith(dist + sep) || !contentType) {
      unexpectedRequests.push(request.url())
      return route.abort('blockedbyclient')
    }
    try {
      await route.fulfill({ contentType, body: await readFile(path) })
    } catch {
      await route.fulfill({ status: 404, body: 'File is absent from the production build' })
    }
  })
}

const executablePath = process.env.LOFOLD_READER_CHROMIUM
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : { channel: 'chromium' }),
  args: ['--disable-background-networking', '--no-first-run'],
})
let totalFailures = 0
try {
  for (const [name, width, theme, captureExports] of selected) {
    const height = 800
    const id = `${name}-${width}-${theme}`
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' })
    const unexpectedRequests = []
    const errors = []
    await attachLocalRoutes(context, unexpectedRequests)
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    let result
    try {
      await page.addInitScript(await fixtureScript(name, { theme }))
      await page.goto(origin, { waitUntil: 'load' })
      const { exports: _output, ...report } = await page.evaluate(scenarioScript(name, { theme, width, height, captureExports }))
      result = report
    } catch (error) {
      result = { checks: [{ name: String(error), ok: false }] }
    }
    result.checks.push({ name: 'no unexpected browser network requests', ok: unexpectedRequests.length === 0 })
    result.checks.push({ name: 'no uncaught browser errors', ok: errors.length === 0 })
    const failures = result.checks.filter(check => !check.ok)
    await writeFile(join(artifacts, id + '.json'), JSON.stringify({ ...result, unexpectedRequests, errors }, null, 2) + '\n')
    if (failures.length) {
      totalFailures += failures.length
      await page.screenshot({ path: join(artifacts, id + '.png') })
      console.error(id + ': ' + failures.map(check => check.name).join(' | '))
    } else {
      console.log(id + ': ' + result.checks.length + ' checks passed')
    }
    await context.close()
  }
} finally {
  await browser.close()
}
assert.equal(totalFailures, 0, 'Reader checks failed. Diagnostics: ' + artifacts)
