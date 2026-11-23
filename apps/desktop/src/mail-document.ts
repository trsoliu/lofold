import type { InlineMailVideo } from './archive'
import type { Theme } from './branding'
import { fitMailStyle, mailFlowElements, mailLayout, mailWidth, type MailLayoutRegion } from './mail-layout'
import { mailStyles } from './mail-safe-style'
import { localMailPicture, mailPictureCandidates } from './mail-pictures'
import { describeMailVideo } from './mail-video'
import { pictureSlot, type PictureSources } from './remote-mail-images'

type ReaderPalette = Pick<Theme, 'scheme' | 'surface' | 'ink'>

// Parse in an inert template and serialize only explicitly supported HTML. The
// original nodes are never adopted into a live page, including during export.
const allowed = new Set(('address article aside b bdi bdo big blockquote br caption center cite code col colgroup dd del div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd li main mark ol p pre q s samp section small span strike strong sub sup table tbody td tfoot th thead tr tt u ul wbr').split(' '))
const discard = new Set(('audio base button canvas embed fieldset form frame frameset head iframe input link math meta noscript object optgroup option script select source style svg template textarea title track video').split(' '))
const voidTags = new Set(['br', 'col', 'hr', 'img', 'wbr'])
const quoteContainers = '.gmail_quote, .gmail_quote_container, .yahoo_quoted, .protonmail_quote'
const replyHeaders = '.gmail_attr, .moz-cite-prefix, #divRplyFwdMsg'
// Long identifiers can break without shrinking neighboring headings to a letter.
const longCellToken = /([\x21-\x7e]{48,})/

function historyHint(node: Element, tag: string) {
  if (tag === 'blockquote' && node.getAttribute('type')?.toLowerCase() === 'cite') return 'quote'
  if (tag !== 'div' && tag !== 'p' && tag !== 'section' && tag !== 'blockquote') return null
  if (node.matches(quoteContainers)) return 'quote'
  return node.matches(replyHeaders) ? 'header' : null
}

export function escapeMail(value: string) {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

type RGB = [number, number, number]
type MailColor = { rgb: RGB; alpha: number }
type ColorContext = { background: RGB; authoredInk?: string }

function luminance(rgb: RGB) {
  const [r, g, b] = rgb.map(value => {
    const channel = value / 255
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4
  })
  return .2126 * r + .7152 * g + .0722 * b
}

function blend(color: MailColor, background: RGB): RGB {
  return color.rgb.map((channel, i) => channel * color.alpha + background[i] * (1 - color.alpha)) as RGB
}

function darkMailColors(palette: ReaderPalette) {
  const canvas = document.createElement('canvas').getContext('2d')
  if (!canvas) return null
  const cache = new Map<string, MailColor | undefined>()
  const read = (value: string) => {
    if (!value || /^(inherit|initial|unset|revert|currentcolor)$/i.test(value)) return
    if (cache.has(value)) return cache.get(value)
    // Using a detached canvas normalizes CSS colors without rendering the message.
    canvas.fillStyle = '#010203'
    canvas.fillStyle = value
    if (canvas.fillStyle === '#010203') {
      canvas.fillStyle = '#040506'
      canvas.fillStyle = value
      if (canvas.fillStyle === '#040506') return
    }
    const css = canvas.fillStyle
    const hex = /^#([0-9a-f]{6})$/i.exec(css)?.[1]
    const channels = /^rgba\(([^)]+)\)$/i.exec(css)?.[1].split(',').map(Number)
    const parsed = hex
      ? { rgb: [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)) as RGB, alpha: 1 }
      : channels ? { rgb: channels.slice(0, 3) as RGB, alpha: channels[3] } : undefined
    cache.set(value, parsed)
    return parsed
  }
  const base = { background: read(palette.surface)!.rgb }
  const styles = document.createElement('span').style
  function apply(safeCss: string[], parent: ColorContext, tag: string): ColorContext {
    if (!safeCss.length && tag !== 'mark') return parent
    styles.cssText = safeCss.join(';')
    const backgroundColor = read(styles.backgroundColor || (tag === 'mark' ? '#ffff00' : ''))
    const channels = backgroundColor?.rgb
    // Keep intentional color blocks, including light sections within them.
    const isPaper = parent.background === base.background && channels && Math.min(...channels) >= 232
      && Math.max(...channels) - Math.min(...channels) <= 16 && tag !== 'mark'
    if (isPaper) safeCss.push('background-color:transparent')
    const background = backgroundColor && backgroundColor.alpha > 0 && !isPaper
      ? blend(backgroundColor, parent.background) : parent.background
    const hasInk = !!read(styles.color)
    if (background === parent.background && !hasInk && tag !== 'mark') return parent
    const authoredInk = hasInk ? styles.color : parent.authoredInk
    const backgroundLight = luminance(background)
    const canRead = (value: string) => {
      const color = read(value)!
      if (color.alpha === 0) return true
      const ink = luminance(blend(color, background))
      return (Math.max(ink, backgroundLight) + .05) / (Math.min(ink, backgroundLight) + .05) >= 4.5
    }
    const ink = [authoredInk, palette.ink, '#000000', '#ffffff'].find(value => value && canRead(value))
    if (ink) safeCss.push('color:' + ink)
    return { background, authoredInk }
  }
  return { base, apply }
}

export function cleanMailHtml(html: string, inlineImages: Record<string, string>, palette?: ReaderPalette, sources?: PictureSources,
  inlineVideos: Record<string, InlineMailVideo> = {}, videos?: InlineMailVideo[]) {
  if (!html || html.length > 1024 * 1024) return null
  const template = document.createElement('template')
  template.innerHTML = html
  const readStyle = mailStyles(template.content)
  const decorate = mailLayout(readStyle)
  const dark = palette?.scheme === 'dark' ? darkMailColors(palette) : null
  const result: string[] = []
  let count = 0, total = 0, overLimit = false, visible = false
  const add = (fragment: string) => {
    total += fragment.length
    if (total > 8 * 1024 * 1024) overLimit = true
    else result.push(fragment)
  }
  function visit(node: Node, depth: number, context?: ColorContext, inCell = false, region: MailLayoutRegion = {}) {
    if (overLimit) return
    if (++count > 32_000 || depth > 96) { overLimit = true; return }
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || ''
      if (/\S/.test(text)) visible = true
      if (inCell && text.length >= 48) {
        for (const [index, chunk] of text.split(longCellToken).entries()) {
          const escaped = escapeMail(chunk)
          add(index % 2 ? '<span class="mail-long-token">' + escaped + '</span>' : escaped)
        }
      } else add(escapeMail(text))
      return
    }
    if (!(node instanceof HTMLElement) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') return
    if (node.hidden || node.style.display === 'none') return
    const tag = node.localName === 'a' ? 'span' : node.localName
    const isVideo = tag === 'video' || tag === 'iframe'
    if (!isVideo && discard.has(tag)) return
    const authored = readStyle(node)
    if (authored.properties.get('display') === 'none') return
    if (isVideo) {
      const description = describeMailVideo(node, inlineVideos)
      if (!description) return
      const posterSource = node.getAttribute('poster') || ''
      const poster = localMailPicture(posterSource, inlineImages)
      const pictureIndex = poster ? null : pictureSlot(sources, posterSource)
      const preview = poster ? '<img alt="视频封面" src="' + escapeMail(poster) + '">'
        : pictureIndex === null ? '' : '<img alt="视频封面" data-mail-picture="' + pictureIndex + '">'
      if (description.local && videos) {
        const part = description.local
        let index = videos.findIndex(video => video.ordinal === part.ordinal)
        if (index === -1) index = videos.push(part) - 1
        add('<span class="mail-video" data-mail-video="' + part.ordinal + '">' + preview +
          '<span class="mail-video-caption">内嵌视频 ' + (index + 1) + '</span></span>')
      } else if (description.remote && palette) {
        add('<div class="mail-video">' + preview + '<details><summary>外部视频 · ' +
          escapeMail(description.remote.host) + '</summary><code>' +
          escapeMail(description.remote.href) + '</code></details></div>')
      } else {
        add('<span class="mail-video">' + preview + (description.remote ? '外部视频' : '内嵌视频') + '</span>')
      }
      visible = true
      return
    }
    if (!allowed.has(tag)) {
      for (const child of node.childNodes) visit(child, depth + 1, context, inCell, region)
      return
    }
    const layout = decorate(node, region, authored)
    const scroll = node instanceof HTMLTableElement && layout.table?.scroll ? layout.table : undefined
    const attrs: string[] = []
    const attr = (name: string, value: string) => attrs.push(' ' + name + '="' + escapeMail(value) + '"')
    const history = historyHint(node, tag)
    if (history) attr('data-mail-history', history)
    if (layout.classes.length) attr('class', layout.classes.join(' '))
    const widthAttribute = layout.removeWidth ? '' : mailWidth(node)
    if (widthAttribute) attr('width', node.getAttribute('width')!)
    const properties = new Map(authored.properties)
    fitMailStyle(node, authored, properties, layout, widthAttribute, readStyle)
    if (tag === 'table') {
      const padding = node.getAttribute('cellpadding')
      const presentation = /^(?:none|presentation)$/i.test(node.getAttribute('role') || '')
      if (presentation) attr('role', 'presentation')
      if (padding && /^\d{1,2}$/.test(padding) && Number(padding) <= 32) properties.set('--cell-padding', padding + 'px')
      else properties.set('--cell-padding', presentation ? '0px' : '.25em .5em')
      if (node.getAttribute('align')?.toLowerCase() === 'center') {
        if (!properties.has('margin-left')) properties.set('margin-left', 'auto')
        if (!properties.has('margin-right')) properties.set('margin-right', 'auto')
      }
    }
    const safeCss = Array.from(properties, ([prop, value]) => prop + ':' + value)
    if (dark && context) context = dark.apply(safeCss, context, tag)
    const dir = node.getAttribute('dir')
    if (dir && /^(ltr|rtl|auto)$/.test(dir)) attr('dir', dir)
    for (const key of ['colspan', 'rowspan', 'start', 'cellpadding', 'cellspacing', 'border', 'size']) {
      const value = node.getAttribute(key)
      if (value && /^\d{1,4}$/.test(value) && Number(value) <= (key === 'start' ? 9999 : key === 'size' ? 7 : 32)) attr(key, value)
    }
    if (tag === 'col' || tag === 'colgroup') {
      const span = node.getAttribute('span')
      if (span && /^\d{1,2}$/.test(span) && Number(span) >= 1 && Number(span) <= 32) attr('span', span)
    }
    if (tag === 'th') {
      const scope = node.getAttribute('scope')?.toLowerCase()
      if (scope && /^(?:row|col|rowgroup|colgroup)$/.test(scope)) attr('scope', scope)
    }
    // Local backgrounds use validated raster bytes. URLs from the sender
    // reach the image loader only after the user requests external pictures.
    if (/^(?:td|th|div|table|section)$/.test(tag)) {
      const cssImage = authored.background
      const source = cssImage
        ? /^url\(["']?(.+?)["']?\)$/i.exec(cssImage)?.[1]
        : node.getAttribute('background')
      const local = source ? localMailPicture(source, inlineImages) : null
      const remote = source && !local ? pictureSlot(sources, source) : null
      if (local || remote !== null) {
        if (local) {
          attr('data-picture-loaded', '')
          safeCss.push('background-image:url("' + local + '")')
        } else attr('data-mail-background', String(remote))
        const height = authored.height || (node.getAttribute('height') || '') + 'px'
        if (/^\d{1,4}(?:\.\d+)?px$/.test(height) && parseFloat(height) <= 1200) {
          safeCss.push('--picture-height:' + height)
        }
        visible = true
      }
    }
    if (tag === 'img') {
      const alt = (node.getAttribute('alt') || '').slice(0, 320)
      const candidates = mailPictureCandidates(node)
      let data = null
      for (const source of candidates.local) {
        data = localMailPicture(source, inlineImages)
        if (data) break
      }
      const height = node.getAttribute('height') || ''
      const styleHeight = authored.height || height + 'px'
      if (/^\d{1,4}(?:\.\d+)?px$/.test(styleHeight) && parseFloat(styleHeight) <= 1200
        && !(widthAttribute || authored.properties.get('width'))) safeCss.push('max-height:' + styleHeight)
      if (/^\d{1,4}$/.test(height) && Number(height) <= 1200) attr('height', height)
      if (safeCss.length) attr('style', safeCss.join(';'))
      if (!data) {
        const tiny = (value: string) => /^(?:[012](?:\.0+)?(?:px)?)$/.test(value.trim())
        if (tiny(authored.properties.get('width') || node.getAttribute('width') || '') || tiny(authored.height || height)) return
        for (const source of candidates.remote) {
          const index = pictureSlot(sources, source)
          if (index === null) continue
          attr('data-mail-picture', String(index))
          attr('alt', alt)
          add('<img' + attrs.join('') + '>')
          visible = true
          break
        }
        if (alt.trim()) { add('<span class="image-alt">' + escapeMail(alt) + '</span>'); visible = true }
        return
      }
      attr('src', data)
      attr('alt', alt)
      visible = true
    } else if (safeCss.length) attr('style', safeCss.join(';'))
    if (scroll) {
      const contained = scroll.containedScroll ? ' mail-table-scroll--contained' : ''
      add('<div class="mail-table-scroll' + contained + '">')
    }
    add('<' + tag + attrs.join('') + '>')
    if (voidTags.has(tag)) return
    for (const child of node.childNodes) visit(child, depth + 1, context, inCell || tag === 'td' || tag === 'th', layout)
    add('</' + tag + '>')
    if (scroll) add('</div>')
  }
  for (const node of template.content.childNodes) visit(node, 0, dark?.base)
  return overLimit || !visible ? null : result.join('')
}

const policy = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'; connect-src 'none'"
const sheet = `
*{box-sizing:border-box}html,body{margin:0;padding:0}body{color:#27303a;background:white;font:15px/1.65 -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif;overflow-wrap:anywhere}
#mail-content{display:flow-root;padding:3px 1px 8px}#mail-content>:first-child{margin-top:0}#mail-content>:last-child{margin-bottom:0}
p{margin:.6em 0}h1,h2,h3,h4,h5,h6{line-height:1.35;margin:1em 0 .45em}h1{font-size:1.6em}h2{font-size:1.35em}
table{border-collapse:collapse}
#mail-content :where(${mailFlowElements.join(',')},.mail-field-table,.mail-layout-table){max-width:100%}
.mail-table-scroll{min-inline-size:0;max-inline-size:100%}
.mail-field-table,.mail-field-group{width:100%}
.mail-field-group{display:table;border-collapse:collapse}
.mail-field-row{display:table-row}
.mail-field-row>:is(.mail-field-label,.mail-field-value){display:table-cell;vertical-align:top}
.mail-field-table .mail-field-label,.mail-field-row>.mail-field-label{width:1%}
.mail-field-table :is(.mail-field-label,.mail-field-value){vertical-align:top}
.mail-field-list{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:0 .8em}
.mail-field-list>dd{margin-inline-start:0}
.mail-field-label,.mail-column-label,.mail-layout-heading{white-space:nowrap!important}
.mail-field-label>p{margin-block:0}
.mail-field-row>.mail-field-label{padding-inline-end:.8em}
.mail-field-value{overflow-wrap:anywhere}
/* Keep whole words in the table's intrinsic column widths. */
td,th{padding:var(--cell-padding,.25em .5em);overflow-wrap:break-word;word-break:normal}
.mail-long-token{overflow-wrap:anywhere;white-space:normal}
table[border]:not([border="0"]) :is(td,th){border:1px solid #a6afbb}
blockquote{margin:.65em 0;padding-inline-start:.8em;border-inline-start:2px solid var(--mail-divider,#a6afbb);color:#485667}
blockquote blockquote{margin-inline:0!important;padding-inline:0!important;border-left:0!important;border-right:0!important}
pre,.plain{white-space:pre-wrap;overflow-wrap:anywhere}pre{font: .92em/1.55 ui-monospace,monospace}
img{max-width:100%;height:auto;vertical-align:middle}
img[data-mail-picture]:not([src]),img[data-mail-picture][src]+.image-alt{display:none!important}
[data-picture-loaded]{height:var(--picture-height,auto);background-repeat:no-repeat}
.image-alt{color:#66717f;font-size:.94em}
.mail-video{display:block;margin:.5em 0;overflow-wrap:anywhere}
.mail-video :is(img,video){display:block;max-width:100%;max-height:420px;height:auto}
.mail-video [hidden]{display:none}
.mail-video video{width:min(100%,720px);object-fit:contain}
.mail-video summary{min-height:40px;cursor:pointer;color:inherit;font:inherit}
.mail-history{margin-block:12px;border-block-start:1px solid var(--mail-divider,#d6dce2)}
.mail-history-summary{padding:8px 0;color:inherit;font-size:13px;font-weight:600;line-height:1.45;overflow-wrap:anywhere}
.mail-history-content{min-width:0;padding-block:3px 7px}
.mail-history-content>:first-child{margin-block-start:0}
.mail-history-content>:last-child{margin-block-end:0}
body.export{padding:34px 40px 42px}header.envelope{border-bottom:1px solid #d6dce2;margin-bottom:21px;padding-bottom:15px}header.envelope h1{margin:0 0 13px;font-size:24px}
header.envelope p{margin:3px 0;font-size:13px;color:#404956}header.envelope b{color:#242e3a}
`
const readingSheet = `
body.reading{background:var(--mail-surface);color:var(--mail-ink);line-height:1.75;text-size-adjust:100%;-webkit-text-size-adjust:100%}
.reading{--mail-divider:#9da9b7;--mail-hover:transparent}
@supports(color:color-mix(in srgb, white, black)){
  .reading{--mail-divider:color-mix(in srgb,var(--mail-ink) 23%,var(--mail-surface));--mail-hover:color-mix(in srgb,var(--mail-ink) 6%,var(--mail-surface))}
}
.reading #mail-content{padding:1px 0 6px;overflow-x:auto}
.reading .mail-table-scroll{overflow-x:auto;overscroll-behavior-inline:contain}
.reading .mail-table-scroll--contained{contain:inline-size}
.reading .mail-layout-shell:has(.mail-table-scroll--contained){width:100%}
.reading .mail-table-scroll:focus-visible{outline:2px solid currentColor;outline-offset:-2px}
.reading p{margin:.65em 0}
.reading h1{font-size:clamp(1.25rem,4vw,1.5rem);margin-block-start:.55em}
.reading h2{font-size:1.17em}
.reading :is(h1,h2,h3){text-wrap:balance}
.reading #mail-content>:first-child>:is(h1,h2,h3):first-child{margin-block-start:0}
.reading blockquote,.reading .image-alt{color:inherit}
.reading mark{background-color:#ff0;color:#000}
.reading .mail-history{margin-block:0}
.reading .mail-history:first-of-type{margin-block-start:12px}
.reading summary.mail-history-summary{min-height:40px;padding:10px 8px;cursor:pointer;border-radius:5px}
.reading summary.mail-history-summary:hover{background:var(--mail-hover)}
.reading summary.mail-history-summary:focus-visible{outline:2px solid currentColor;outline-offset:-2px}
.reading .mail-history-content br+br+br{display:none}
`
export function mailDocument(body: string, envelope = '', palette?: ReaderPalette) {
  const readerStyle = palette
    ? ' style="color-scheme:' + palette.scheme + ';--mail-surface:' + palette.surface + ';--mail-ink:' + palette.ink + '"'
    : ''
  const mediaPolicy = palette ? "; media-src blob:" : ''
  const bodyClass = palette ? ' class="reading"' : envelope ? ' class="export"' : ''
  return '<!doctype html><html lang="zh-CN"' + readerStyle + '><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + policy + mediaPolicy + '"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + sheet + (palette ? readingSheet : '') + '</style></head><body' + bodyClass + '>' + envelope + '<div id="mail-content">' + body + '</div></body></html>'
}
