import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

// Drive only the packaged application's local WebView2 on the disposable runner.
const phase = process.argv[2]
assert.ok(['import', 'restart'].includes(phase))
const fixture = await readFile(new URL('../../packages/mail-store/tests/fixtures/chinese-attachment.eml', import.meta.url))
const deadline = Date.now() + 90_000
let page
while (!page && Date.now() < deadline) {
  try {
    const response = await fetch('http://127.0.0.1:9223/json/list', { signal: AbortSignal.timeout(2000) })
    const pages = await response.json()
    page = pages.find(({ type, url }) => type === 'page' && /^https?:\/\/tauri\.localhost\//.test(url))
  } catch {
    // The app and WebView2 may still be starting.
  }
  if (!page) await delay(500)
}
assert.ok(page, 'Packaged LoFold WebView2 did not start')
const socket = new WebSocket(page.webSocketDebuggerUrl)
const timeout = setTimeout(() => { throw new Error('Local application automation timed out') }, 60_000)
try {
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const done = new Promise((resolve, reject) => {
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data)
      if (message.id !== 1) return
      if (message.error || message.result.exceptionDetails) reject(new Error(JSON.stringify(message)))
      else resolve(message.result.result.value)
    })
    socket.addEventListener('error', reject, { once: true })
  })
  // The app uses these same native IPC calls to import, search, and read an EML.
  // Encode the public fixture as base64 so the original CRLF bytes reach SQLCipher.
  async function verify(phase, base64) {
    for (let tries = 0; tries < 100 && !document.querySelector('#root')?.childElementCount; tries++) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!document.querySelector('#root')?.childElementCount) throw new Error('App UI did not render')
    const invoke = window.__TAURI_INTERNALS__.invoke
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0))
    const result = await invoke('import_eml', bytes.buffer)
    const matches = await invoke('list_mail', { query: '差旅', offset: 0, folder: 'archive' })
    const detail = await invoke('read_mail', { id: result.id })
    return { duplicate: result.duplicate, matches: matches.items.map(mail => mail.id), id: result.id,
      subject: detail.subject, attachment: detail.attachments[0]?.name }
  }
  socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
    expression: '(' + verify.toString() + ')(' + JSON.stringify(phase) + ',' + JSON.stringify(fixture.toString('base64')) + ')',
    awaitPromise: true, returnByValue: true,
  } }))
  const result = await done
  assert.equal(result.duplicate, phase === 'restart')
  assert.deepEqual(result.matches, [result.id])
  assert.equal(result.subject, '本地邮箱往返测试')
  assert.equal(result.attachment, '差旅行程.csv')
  console.log('Packaged LoFold passed the ' + phase + ' check in WebView2.')
} finally {
  clearTimeout(timeout)
  socket.close()
}
