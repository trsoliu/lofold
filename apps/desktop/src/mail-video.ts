import type { InlineMailVideo } from './archive'

function localReference(source: string, parts: Record<string, InlineMailVideo>) {
  let key = source
  if (/^cid:/i.test(source)) {
    try { key = decodeURIComponent(source.slice(4)).replace(/^<|>$/g, '') } catch { return }
  }
  if (!Object.prototype.hasOwnProperty.call(parts, key)) return
  const part = parts[key]
  if (part && Number.isSafeInteger(part.ordinal) && part.ordinal >= 0
    && (part.mime === 'video/mp4' || part.mime === 'video/webm')) return part
}

function externalVideo(source: string) {
  if (!/^(?:https:)?\/\//i.test(source) || source.length > 8192) return
  try {
    const url = new URL(source.startsWith('//') ? 'https:' + source : source)
    if (url.protocol === 'https:' && !url.username && !url.password) return url
  } catch { /* Invalid sources are left out of the reader. */ }
}

const embedPaths: Record<string, RegExp> = {
  'www.youtube.com': /^\/embed\//,
  'www.youtube-nocookie.com': /^\/embed\//,
  'player.vimeo.com': /^\/video\//,
  'www.tiktok.com': /^\/(?:embed|player)\//,
  'player.bilibili.com': /^\/player\.html$/,
}

export function describeMailVideo(element: Element, parts: Record<string, InlineMailVideo>) {
  const choices = [element, ...Array.from(element.children).filter(child => child.localName === 'source')]
    .map(node => node.getAttribute('src')?.trim() || '').filter(Boolean)
  if (element.localName === 'video') {
    const local = choices.map(source => localReference(source, parts)).find(part => part !== undefined)
    if (local) return { local }
    const remote = choices.map(externalVideo).find(url => url !== undefined)
    return { remote }
  }
  const remote = externalVideo(choices[0] || '')
  const path = remote && Object.prototype.hasOwnProperty.call(embedPaths, remote.hostname) && embedPaths[remote.hostname]
  if (path && path.test(remote.pathname)) return { remote }
}

export function makeMailVideoUrl(part: InlineMailVideo, raw: ArrayBuffer | number[]) {
  const length = Array.isArray(raw) ? raw.length : raw?.byteLength
  if (!length || length > 16 * 1024 * 1024) throw new Error('视频数据不可用')
  const bytes = Array.isArray(raw) ? Uint8Array.from(raw) : raw
  return URL.createObjectURL(new Blob([bytes], { type: part.mime }))
}

// The iframe forbids script. Native video controls use a local Blob created
// after the explicit action in the host reading pane.
export function showMailVideo(child: Document | null | undefined, ordinal: number, src: string) {
  let first: HTMLVideoElement | undefined
  for (const holder of child?.querySelectorAll(`[data-mail-video="${ordinal}"]`) ?? []) {
    const existing = holder.querySelector('video')
    if (existing) {
      first ??= existing
      continue
    }
    const doc = holder.ownerDocument
    const poster = holder.querySelector('img')
    const video = doc.createElement('video')
    const preview = poster?.getAttribute('src')
    if (preview) video.poster = preview
    video.controls = true
    video.playsInline = true
    video.preload = 'metadata'
    video.setAttribute('aria-label', '内嵌邮件视频')
    video.src = src
    holder.appendChild(video)
    if (poster) poster.hidden = true
    holder.querySelector('.mail-video-caption')?.setAttribute('hidden', '')
    first ??= video
  }
  return first
}
