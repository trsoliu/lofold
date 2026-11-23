import assert from 'node:assert/strict'
import test from 'node:test'
import { localMailPicture, mailPictureCandidates } from '../src/mail-pictures.ts'

const pixel = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='

test('resolves the present message’s CID and Content-Location aliases', () => {
  const parts = { 'Photo@local.test': pixel, 'assets/diagram.gif': pixel, 'https://example.test/logo.gif': pixel }
  assert.equal(localMailPicture('CID:%3cphoto%40local.test%3E', parts), pixel)
  assert.equal(localMailPicture('./assets/diagram.gif#thumbnail', parts), pixel)
  assert.equal(localMailPicture('https://example.test/logo.gif', parts), pixel)
  assert.equal(localMailPicture('cid:absent', parts), null)
  assert.equal(localMailPicture('cid:toString', parts), null)
  assert.equal(localMailPicture('cid:photo', { Photo: pixel, PHOTO: pixel }), null)
})

test('accepts bounded raster data and rejects mismatched formats and huge canvases', () => {
  assert.equal(localMailPicture(pixel, {}), pixel)
  assert.equal(localMailPicture(pixel.replace('image/gif', 'image/png'), {}), null)
  assert.equal(localMailPicture('data:image/svg+xml;base64,PHN2Zy8+', {}), null)
  const oversized = Buffer.from(pixel.split(',')[1], 'base64')
  oversized.writeUInt16LE(65535, 6)
  assert.equal(localMailPicture('data:image/gif;base64,' + oversized.toString('base64'), {}), null)
})

test('finds picture and lazy candidates without splitting the comma inside a data URL', () => {
  function element(localName, attrs) {
    return { localName, getAttribute: name => attrs[name] ?? null }
  }
  const source = element('source', { srcset: pixel + ' 1x, cid:large 2x' })
  const img = element('img', {
    src: 'https://example.test/fallback.gif',
    'data-srcset': 'cid:alternate 800w, cid:big 1200w',
  })
  img.parentElement = { localName: 'picture', children: [source, img] }
  const candidates = mailPictureCandidates(img)
  assert.deepEqual(candidates.local, [pixel, 'cid:large', 'cid:alternate', 'cid:big', 'https://example.test/fallback.gif'])
  assert.equal(candidates.remote[0], 'https://example.test/fallback.gif')
})
