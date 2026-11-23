import { useEffect, useMemo, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { MailDetail } from './archive'
import type { Theme } from './branding'
import { cleanMailHtml, escapeMail, mailDocument } from './mail-document'
import { formatMailHistory, formatPlainHistory } from './mail-history'
import './message-body.css'

function richMarkup(detail: MailDetail, theme?: Theme) {
  return detail.richBody ? cleanMailHtml(detail.richBody.html, detail.richBody.inlineImages || {}, theme) : null
}

export function MessageBody({ detail, theme }: { detail: MailDetail; theme: Theme }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const { srcDoc, plainFallback } = useMemo(() => {
    const html = richMarkup(detail, theme)
    const body = html ? formatMailHistory(html, true) : formatPlainHistory(detail.body, true)
    return { srcDoc: body ? mailDocument(body, '', theme) : null, plainFallback: !html }
  }, [detail, theme])
  useEffect(() => {
    const target = frame.current
    if (!target || !srcDoc) return
    let observer: ResizeObserver | undefined
    let child: Document | null = null
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
      observer?.disconnect()
      child?.removeEventListener('keydown', shortcut)
      child = target?.contentDocument ?? null
      child?.addEventListener('keydown', shortcut)
      const content = child?.getElementById('mail-content')
      if (!content || !target) return
      const tables = content.querySelectorAll<HTMLElement>('.mail-table-scroll')
      const resize = () => {
        target.style.height = Math.min(40000, Math.ceil(content.getBoundingClientRect().height) + 2) + 'px'
        for (const table of tables) {
          if (table.scrollWidth > table.clientWidth) {
            table.tabIndex = 0
            table.setAttribute('role', 'region')
            table.setAttribute('aria-label', '邮件表格')
          } else if (table.hasAttribute('tabindex')) {
            table.removeAttribute('tabindex')
            table.removeAttribute('role')
            table.removeAttribute('aria-label')
          }
        }
      }
      observer = new ResizeObserver(resize)
      observer.observe(content)
      resize()
    }
    target.addEventListener('load', loaded)
    loaded()
    return () => {
      observer?.disconnect()
      child?.removeEventListener('keydown', shortcut)
      target.removeEventListener('load', loaded)
    }
  }, [srcDoc])
  if (!srcDoc) return <>
    <div className="message-body">{detail.body.trim() ? detail.body : <p className="muted">没有可预览的正文。</p>}</div>
    {detail.bodyTruncated && <p className="muted">正文已达到预览长度上限，可导出 EML 查阅全文。</p>}
  </>
  // Same-origin permits the host to measure its child. The sandbox forbids all
  // script execution, navigation of the parent, forms, downloads and pop-ups.
  return <>
    <iframe ref={frame} title="邮件排版正文" sandbox="allow-same-origin" referrerPolicy="no-referrer" className="rich-mail-frame" srcDoc={srcDoc} />
    {plainFallback && detail.bodyTruncated && <p className="message-preview-limit muted">正文已达到预览长度上限，可导出 EML 查阅全文。</p>}
  </>
}

function outputDocument(detail: MailDetail) {
  const rich = richMarkup(detail)
  if (!rich && detail.bodyTruncated) throw new Error('正文超过完整排版的处理上限，请导出 EML 原件。')
  const fields = [
    ['发件人', detail.sender || '未知发件人'], ['收件人', detail.recipients],
    ['时间', detail.sentAt == null ? '' : new Date(detail.sentAt * 1000).toLocaleString('zh-CN', { hour12: false })],
    ['附件', detail.attachments.map(file => file.name).join('、')],
  ]
  const envelope = '<header class="envelope"><h1>' + escapeMail(detail.subject || '无主题') + '</h1>' +
    fields.filter(([, value]) => value).map(([key, value]) => '<p><b>' + key + '</b>　' + escapeMail(value) + '</p>').join('') + '</header>'
  const body = rich ? formatMailHistory(rich, false) : formatPlainHistory(detail.body, false)
    ?? '<div class="plain">' + escapeMail(detail.body || '没有可预览的正文。') + '</div>'
  return mailDocument(body, envelope)
}

export async function exportMessageImage(detail: MailDetail, account: number | null) {
  return invoke<boolean>('save_message_image', { id: detail.id, html: outputDocument(detail), account })
}

export async function printMessage(detail: MailDetail) {
  return invoke<boolean>('print_message', { html: outputDocument(detail) })
}
