import assert from 'node:assert/strict'
import test from 'node:test'
import { loadMailPictures, pictureSlot } from '../src/remote-mail-images.ts'

const sample = 'data:image/png;base64,AAAA'

test('picture slots are deduplicated, use HTTPS and bound the set disclosed for a message', () => {
  const sources = { urls: [], limited: false }
  for (const url of ['http://img.example/a', 'https://user@img.example/a', 'https://img.example:8443/a', 'cid:x', 'file:///a']) {
    assert.equal(pictureSlot(sources, url), null)
  }
  assert.equal(pictureSlot(sources, '//img.example/a#thumbnail'), 0)
  assert.equal(pictureSlot(sources, 'https://img.example/a'), 0)
  for (let i = 1; i < 32; i++) assert.equal(pictureSlot(sources, 'https://img.example/' + i), i)
  assert.equal(pictureSlot(sources, 'https://img.example/extra'), null)
  assert.equal(sources.limited, true)
  assert.equal(sources.urls.length, 32)
})

test('partial success is retained; retries skip loaded slots and never expose a non-raster result', async () => {
  const urls = ['a', 'b', 'c']
  const signal = new AbortController().signal
  const first = await loadMailPictures(urls, new Map(), signal, async url => {
    if (url === 'c') throw Error('unavailable')
    return url === 'a' ? sample : 'data:image/svg+xml;base64,AAAA'
  })
  assert.deepEqual([...first.images.keys()], [0])
  const retried = []
  const second = await loadMailPictures(urls, first.images, signal, async url => { retried.push(url); return sample })
  assert.deepEqual(retried.sort(), ['b', 'c'])
  assert.equal(second.images.size, 3)
})

test('an undecodable picture stays eligible for retry and is not shown', async () => {
  const signal = new AbortController().signal
  const displayed = []
  const result = await loadMailPictures(['picture'], new Map(), signal, async () => sample,
    index => displayed.push(index), async () => { throw new Error('invalid picture bytes') })
  assert.deepEqual([...result.images.keys()], [])
  assert.deepEqual(displayed, [])
  const retry = await loadMailPictures(['picture'], result.images, signal, async () => sample,
    index => displayed.push(index), async () => {})
  assert.equal(retry.images.get(0), sample)
  assert.deepEqual(displayed, [0])
})

test('leaving a message stops dispatch and discards outstanding results', async () => {
  const scope = new AbortController()
  const started = [], displayed = []
  let complete
  const pending = new Promise(resolve => { complete = resolve })
  const loading = loadMailPictures(['a', 'b', 'c', 'd'], new Map(), scope.signal,
    url => { started.push(url); return pending }, index => displayed.push(index))
  scope.abort()
  complete(sample)
  const result = await loading
  assert.deepEqual(started, ['a', 'b', 'c'])
  assert.equal(result.images.size, 0)
  assert.deepEqual(displayed, [])
})

test('a large newsletter stays within its cumulative decoded-preview storage budget', async () => {
  const signal = new AbortController().signal
  const data = sample + 'A'.repeat(2 * 1024 * 1024)
  const { images, limited } = await loadMailPictures(Array(12).fill('picture'), new Map(), signal, async () => data)
  assert.equal(limited, true)
  assert.ok(images.size > 0 && images.size * data.length <= 16 * 1024 * 1024)
})
