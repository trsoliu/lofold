import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { InlineMailVideo, MailDetail } from './archive'
import type { Theme } from './branding'
import { cleanMailHtml, escapeMail, mailDocument } from './mail-document'
import { formatMailHistory, formatPlainHistory } from './mail-history'
import { loadMailPictures, type PictureSources } from './remote-mail-images'
import { makeMailVideoUrl, showMailVideo } from './mail-video'
import './message-body.css'

const maxFrameHeight = 40000
const previewLimitText = '正文已达到预览长度上限，可导出 EML 查阅全文。'

function prepareMailBody(detail: MailDetail, theme?: Theme) {
  const sources: PictureSources = { urls: [], limited: false }
  const videos: InlineMailVideo[] = []
  const rich = detail.richBody ? cleanMailHtml(detail.richBody.html, detail.richBody.inlineImages || {}, theme,
    theme ? sources : undefined, detail.richBody.inlineVideos, theme ? videos : undefined) : null
  if (!rich) {
    sources.urls.length = 0
    videos.length = 0
  }
  const markup = rich ? formatMailHistory(rich, !!theme) : formatPlainHistory(detail.body, !!theme)
  return { markup, plainFallback: !rich, sources, videos }
}

async function decodePicture(data: string) {
  const image = new Image()
  image.src = data
  await image.decode()
}

// A new message gets a fresh set of images and consent, even when React reuses
// the rest of the reader between selections.
export function MessageBody(props: { detail: MailDetail; theme: Theme }) {
  return <MailBody key={props.detail.id} {...props} />
}

function showPicture(child: Document | null | undefined, index: number, data: string) {
  if (!child) return
  for (const image of child.querySelectorAll<HTMLImageElement>(`img[data-mail-picture="${index}"]`)) image.src = data
  for (const element of child.querySelectorAll<HTMLElement>(`[data-mail-background="${index}"]`)) {
    element.style.backgroundImage = 'url("' + data + '")'
    element.dataset.pictureLoaded = ''
  }
}

function MailBody({ detail, theme }: { detail: MailDetail; theme: Theme }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const activeLoad = useRef<AbortController | null>(null)
  const pictures = useRef(new Map<number, string>())
  const videoUrls = useRef(new Map<number, string>())
  const videoLoad = useRef<AbortController | null>(null)
  const [videoStatus, setVideoStatus] = useState<{ loading: boolean; text: string }>({ loading: false, text: '' })
  const [imageState, setImageState] = useState<'idle' | 'loading' | 'done' | 'limited'>('idle')
  const [scrollablePreview, setScrollablePreview] = useState(false)
  const { srcDoc, plainFallback, sources, videos } = useMemo(() => {
    const prepared = prepareMailBody(detail, theme)
    return { ...prepared, srcDoc: prepared.markup ? mailDocument(prepared.markup, '', theme) : null }
  }, [detail, theme])
  useLayoutEffect(() => {
    const urls = videoUrls.current
    return () => {
      activeLoad.current?.abort()
      videoLoad.current?.abort()
      for (const url of urls.values()) URL.revokeObjectURL(url)
      urls.clear()
    }
  }, [])

  async function loadVideo(part: InlineMailVideo) {
    if (videoLoad.current) return
    const controller = new AbortController()
    videoLoad.current = controller
    setVideoStatus({ loading: true, text: '正在读取视频…' })
    try {
      let src = videoUrls.current.get(part.ordinal)
      if (!src) {
        const bytes = await invoke<ArrayBuffer | number[]>('load_inline_mail_video', { id: detail.id, ordinal: part.ordinal })
        if (controller.signal.aborted) return
        src = makeMailVideoUrl(part, bytes)
        videoUrls.current.set(part.ordinal, src)
      }
      const player = showMailVideo(frame.current?.contentDocument, part.ordinal, src)
      if (player) {
        player.scrollIntoView({ block: 'nearest' })
        player.focus({ preventScroll: true })
        for (let step = 0; step < 20 && !player.error && player.readyState < 1; step++) {
          if (controller.signal.aborted) return
          await new Promise(resolve => setTimeout(resolve, 50))
        }
      }
      if (controller.signal.aborted) return
      setVideoStatus({ loading: false, text: player?.error ? '当前播放器无法读取此视频，可保存附件后打开。' : '' })
    } catch {
      if (!controller.signal.aborted) setVideoStatus({ loading: false, text: '无法读取此视频，可保存附件后打开。' })
    } finally {
      if (videoLoad.current === controller) videoLoad.current = null
    }
  }

  async function loadPictures() {
    if (activeLoad.current) return
    const controller = new AbortController()
    activeLoad.current = controller
    setImageState('loading')
    const { limited } = await loadMailPictures(sources.urls, pictures.current, controller.signal,
      url => invoke<string>('load_mail_image', { url }),
      (index, data) => {
        pictures.current.set(index, data)
        showPicture(frame.current?.contentDocument, index, data)
      }, decodePicture)
    if (!controller.signal.aborted) {
      activeLoad.current = null
      setImageState(limited ? 'limited' : 'done')
    }
  }
  useEffect(() => {
    const target = frame.current
    if (!target || !srcDoc) return
    let disposeDocument = () => {}
    function shortcut(event: KeyboardEvent) {
      if (event.isComposing || !(event.metaKey || event.ctrlKey || event.altKey)) return
      const relay = new KeyboardEvent('keydown', {
        key: event.key, code: event.code, altKey: event.altKey, metaKey: event.metaKey,
        ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, repeat: event.repeat,
        bubbles: true, cancelable: true,
      })
      // Preserve the iframe's native copy/select behavior unless the mail app
      // actually handles the shortcut.
      if (!window.dispatchEvent(relay)) event.preventDefault()
    }
    function loaded() {
      disposeDocument()
      const child = target?.contentDocument
      const content = child?.getElementById('mail-content')
      if (!child || !content || !target) return
      child.addEventListener('keydown', shortcut)
      for (const [index, data] of pictures.current) showPicture(child, index, data)
      for (const [ordinal, src] of videoUrls.current) showMailVideo(child, ordinal, src)
      const regions = content.querySelectorAll<HTMLElement>('.mail-table-scroll')
      let scheduled = 0
      const measure = () => {
        scheduled = 0
        const height = Math.ceil(content.getBoundingClientRect().height) + 2
        target.style.height = Math.min(maxFrameHeight, height) + 'px'
        setScrollablePreview(height > maxFrameHeight)
        for (const region of regions) {
          if (region.scrollWidth > region.clientWidth + 1) {
            region.tabIndex = 0
            region.setAttribute('role', 'region')
            region.setAttribute('aria-label', '邮件表格')
          } else if (region.hasAttribute('tabindex')) {
            region.removeAttribute('tabindex')
            region.removeAttribute('role')
            region.removeAttribute('aria-label')
          }
        }
      }
      const schedule = () => {
        if (!scheduled) scheduled = requestAnimationFrame(measure)
      }
      const observer = new ResizeObserver(schedule)
      observer.observe(content)
      for (const region of regions) {
        observer.observe(region)
        if (region.firstElementChild) observer.observe(region.firstElementChild)
      }
      const layoutEvents = ['load', 'error', 'loadedmetadata', 'toggle']
      for (const event of layoutEvents) child.addEventListener(event, schedule, true)
      measure()
      disposeDocument = () => {
        cancelAnimationFrame(scheduled)
        observer.disconnect()
        child.removeEventListener('keydown', shortcut)
        for (const event of layoutEvents) child.removeEventListener(event, schedule, true)
      }
    }
    target.addEventListener('load', loaded)
    loaded()
    return () => {
      disposeDocument()
      target.removeEventListener('load', loaded)
    }
  }, [srcDoc])
  if (!srcDoc) return <>
    <div className="message-body">{detail.body.trim() ? detail.body : <p className="muted">没有可预览的正文。</p>}</div>
    {detail.bodyTruncated && <p className="muted">{previewLimitText}</p>}
  </>
  const failed = sources.urls.length - pictures.current.size
  const hosts = [...new Set(sources.urls.map(url => new URL(url).host))]
  // Same-origin permits the host to measure its child. The sandbox forbids all
  // script execution, navigation of the parent, forms, downloads and pop-ups.
  return <>
    {sources.urls.length > 0 && (imageState !== 'done' || failed > 0 || sources.limited) &&
      <div className="message-image-notice">
        <div role="status">
          {imageState === 'idle' && <>外部图片已阻止。加载会连接到 {hosts.length <= 2 ? hosts.join('、') : hosts.length + ' 个图片来源'}，发件人可能获知你已读信。
            {hosts.length > 2 && <details><summary>查看图片来源</summary>{hosts.join('、')}</details>}
          </>}
          {imageState === 'loading' && '正在加载本封邮件的图片…'}
          {imageState === 'done' && failed > 0 && <>有 {failed} 张外部图片未能加载。</>}
          {imageState === 'limited' && '图片已达到本封邮件的预览大小上限。'}
          {sources.limited && imageState !== 'loading' && ' 每封最多加载 32 个图片地址。'}
        </div>
        {imageState !== 'loading' && imageState !== 'limited' && failed > 0 &&
          <button type="button" className="secondary" onClick={loadPictures}>{imageState === 'idle' ? '加载本封图片' : '重试图片'}</button>}
      </div>}
    {videos.length > 0 && <div className="message-video-controls" role="group" aria-label="内嵌视频">
      {videos.map((part, index) => <button type="button" className="secondary" key={part.ordinal}
        disabled={videoStatus.loading} onClick={() => void loadVideo(part)}>
        {videos.length === 1 ? '打开内嵌视频' : '打开内嵌视频 ' + (index + 1)}
      </button>)}
      <span role="status">{videoStatus.text}</span>
    </div>}
    {scrollablePreview && <p id="reader-scroll-hint" className="message-preview-limit muted">可在正文区域内继续滚动，也可导出 EML 查看原件。</p>}
    <iframe ref={frame} title="邮件排版正文" aria-describedby={scrollablePreview ? 'reader-scroll-hint' : undefined}
      sandbox="allow-same-origin" referrerPolicy="no-referrer" className="rich-mail-frame" srcDoc={srcDoc} />
    {plainFallback && detail.bodyTruncated && <p className="message-preview-limit muted">{previewLimitText}</p>}
  </>
}

function outputDocument(detail: MailDetail) {
  const { markup, plainFallback } = prepareMailBody(detail)
  if (plainFallback && detail.bodyTruncated) throw new Error('正文超过完整排版的处理上限，请导出 EML 原件。')
  const fields = [
    ['发件人', detail.sender || '未知发件人'], ['收件人', detail.recipients],
    ['时间', detail.sentAt == null ? '' : new Date(detail.sentAt * 1000).toLocaleString('zh-CN', { hour12: false })],
    ['附件', detail.attachments.map(file => file.name).join('、')],
  ]
  const envelope = '<header class="envelope"><h1>' + escapeMail(detail.subject || '无主题') + '</h1>' +
    fields.filter(([, value]) => value).map(([key, value]) => '<p><b>' + key + '</b>　' + escapeMail(value) + '</p>').join('') + '</header>'
  const body = markup ?? '<div class="plain">' + escapeMail(detail.body || '没有可预览的正文。') + '</div>'
  return mailDocument(body, envelope)
}

export async function exportMessageImage(detail: MailDetail, account: number | null) {
  return invoke<boolean>('save_message_image', { id: detail.id, html: outputDocument(detail), account })
}

export async function printMessage(detail: MailDetail) {
  return invoke<boolean>('print_message', { html: outputDocument(detail) })
}
