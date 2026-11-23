const maxSources = 32
const maxEncodedBytes = 16 * 1024 * 1024
const raster = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-zA-Z0-9+/]+={0,2}$/

export interface PictureSources {
  urls: string[]
  limited: boolean
}

export function remotePictureUrl(source: string) {
  const value = source.trim()
  if (value.length > 8192 || !/^(?:https:)?\/\//i.test(value)) return null
  try {
    const url = new URL(value.startsWith('//') ? 'https:' + value : value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
    url.hash = ''
    return url.href
  } catch { return null }
}

export function pictureSlot(sources: PictureSources | undefined, value: string) {
  if (!sources) return null
  const url = remotePictureUrl(value)
  if (!url) return null
  const prior = sources.urls.indexOf(url)
  if (prior >= 0) return prior
  if (sources.urls.length >= maxSources) {
    sources.limited = true
    return null
  }
  sources.urls.push(url)
  return sources.urls.length - 1
}

export async function loadMailPictures(
  urls: string[], previous: ReadonlyMap<number, string>, signal: AbortSignal,
  fetchPicture: (url: string) => Promise<string>, onPicture?: (index: number, data: string) => void,
  decodePicture?: (data: string) => Promise<void>,
) {
  const images = new Map(previous)
  let size = Array.from(images.values()).reduce((total, data) => total + data.length, 0)
  let cursor = 0, limited = false
  async function worker() {
    while (!signal.aborted && !limited && cursor < Math.min(urls.length, maxSources)) {
      const index = cursor++
      if (images.has(index)) continue
      try {
        const data = await fetchPicture(urls[index])
        if (signal.aborted || typeof data !== 'string' || !raster.test(data)) continue
        if (decodePicture) await decodePicture(data)
        if (signal.aborted) return
        if (size + data.length > maxEncodedBytes) { limited = true; continue }
        images.set(index, data)
        size += data.length
        onPicture?.(index, data)
      } catch { /* Leave the sender's alternative text in place. */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, urls.length) }, worker))
  return { images, limited }
}
