const rasterData = /^data:image\/(png|jpeg|gif|webp);base64,([a-zA-Z0-9+/]+={0,2})$/i
const maxEncodedLength = Math.ceil(2 * 1024 * 1024 / 3) * 4
const maxPixels = 12_000_000

// The sender controls data URLs. Check the format header and declared canvas
// before any of those bytes become a browser resource.
function inlineDataPicture(source: string) {
  if (source.length > maxEncodedLength + 32) return null
  const match = rasterData.exec(source)
  if (!match || match[2].length > maxEncodedLength) return null
  const type = match[1].toLowerCase()
  let bytes: string
  try {
    bytes = atob(match[2])
  } catch {
    return null
  }
  const size = rasterSize(type, bytes)
  if (!size || !size.width || !size.height || size.width > 8192 || size.height > 8192
    || size.width * size.height > maxPixels) return null
  return 'data:image/' + type + ';base64,' + match[2]
}

function rasterSize(type: string, bytes: string) {
  const at = (index: number) => bytes.charCodeAt(index)
  const u16le = (i: number) => at(i) + at(i + 1) * 256
  const u24le = (i: number) => u16le(i) + at(i + 2) * 65_536
  const u16be = (i: number) => at(i) * 256 + at(i + 1)
  const u32be = (i: number) => u16be(i) * 65_536 + u16be(i + 2)
  if (type === 'png' && bytes.startsWith('\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR')) {
    return { width: u32be(16), height: u32be(20) }
  }
  if (type === 'gif' && /^GIF8[79]a/.test(bytes)) {
    return { width: u16le(6), height: u16le(8) }
  }
  if (type === 'webp' && bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP') {
    const chunk = bytes.slice(12, 16)
    if (chunk === 'VP8X') return { width: 1 + u24le(24), height: 1 + u24le(27) }
    if (chunk === 'VP8 ' && bytes.slice(23, 26) === '\x9d\x01\x2a' && bytes.length >= 30) {
      return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff }
    }
    if (chunk === 'VP8L' && at(20) === 0x2f && bytes.length >= 25) {
      return { width: 1 + (u16le(21) & 0x3fff), height: 1 + ((u24le(22) >>> 6) & 0x3fff) }
    }
  }
  if (type === 'jpeg' && bytes.startsWith('\xff\xd8')) {
    let i = 2
    while (at(i) === 0xff) {
      while (at(i) === 0xff) i++
      const marker = at(i++)
      if (marker === 0xda || marker === 0xd9) break
      const length = u16be(i)
      if (!(length >= 2 && i + length <= bytes.length)) break
      if (length >= 8 && [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: u16be(i + 5), height: u16be(i + 3) }
      }
      i += length
    }
  }
  return null
}

function decode(value: string) {
  try { return decodeURIComponent(value) } catch { return value }
}

export function localMailPicture(source: string, inlineImages: Record<string, string>) {
  const value = source.trim()
  if (/^data:/i.test(value)) return inlineDataPicture(value)
  if (!value || value.length > 8192) return null
  const isCid = /^cid:/i.test(value)
  const key = (isCid ? value.slice(4) : value).replace(/^<|>$/g, '')
  const keys = [key, decode(key).replace(/^<|>$/g, '')]
  if (!isCid) {
    const path = key.split('#', 1)[0]
    keys.push(path, path.replace(/^\.\//, ''))
  }
  for (const alias of keys) {
    if (Object.prototype.hasOwnProperty.call(inlineImages, alias) && rasterData.test(inlineImages[alias])) return inlineImages[alias]
  }
  if (isCid) {
    // Exact lookup wins. Some senders vary only the casing of a Content-ID.
    const matches = Object.keys(inlineImages).filter(alias => alias.toLowerCase() === keys[1].toLowerCase())
    if (matches.length === 1 && rasterData.test(inlineImages[matches[0]])) return inlineImages[matches[0]]
  }
  return null
}

// Read URL tokens using the srcset separator rules so the comma in a data URL
// is part of the URL. Width and density descriptors never enter the output.
function imageSet(source: string | null) {
  const candidates: string[] = []
  const input = (source || '').slice(0, 1024 * 1024)
  const pattern = /[^\t\n\f\r ,][^\t\n\f\r ]*/g
  while (candidates.length < 12) {
    const token = pattern.exec(input)
    if (!token) break
    const url = token[0].replace(/,+$/, '')
    if (url === token[0]) {
      const separator = input.indexOf(',', pattern.lastIndex)
      pattern.lastIndex = separator < 0 ? input.length : separator + 1
    }
    if (url) candidates.push(url)
  }
  return candidates
}

export function mailPictureCandidates(image: Element) {
  const responsive: string[] = []
  if (image.parentElement?.localName === 'picture') {
    for (const child of image.parentElement.children) {
      if (child === image || responsive.length >= 12) break
      if (child.localName === 'source') responsive.push(...imageSet(child.getAttribute('srcset')))
    }
  }
  const src = image.getAttribute('src') || ''
  const lazy = image.getAttribute('data-src') || ''
  const alternatives = [...responsive, ...imageSet(image.getAttribute('srcset')),
    ...imageSet(image.getAttribute('data-srcset')), lazy].filter(Boolean)
  return { local: [...alternatives, src], remote: [src, ...alternatives] }
}
