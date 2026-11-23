import type { Theme } from './branding'

type ReaderPalette = Pick<Theme, 'scheme' | 'surface' | 'ink'>

// Parse in an inert template and serialize only explicitly supported HTML. The
// original nodes are never adopted into a live page, including during export.
const allowed = new Set(('address article aside b bdi bdo big blockquote br caption center cite code col colgroup dd del div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd li main mark ol p pre q s samp section small span strike strong sub sup table tbody td tfoot th thead tr tt u ul wbr').split(' '))
const discard = new Set(('audio base button canvas embed fieldset form frame frameset head iframe input link math meta noscript object optgroup option picture script select source style svg template textarea title track video').split(' '))
const voidTags = new Set(['br', 'col', 'hr', 'img', 'wbr'])
const colors = new Set(['color', 'background-color', 'border-color', 'border-top-color', 'border-bottom-color', 'border-left-color', 'border-right-color'])
const enums: Record<string, RegExp> = {
  'text-align': /^(left|right|center|justify|start|end)$/,
  'vertical-align': /^(baseline|middle|top|bottom|sub|super|text-top|text-bottom)$/,
  'font-weight': /^(normal|bold|bolder|lighter|[1-9]00)$/,
  'font-style': /^(normal|italic|oblique)$/,
  'white-space': /^(normal|nowrap|pre-wrap|pre-line|break-spaces)$/,
  'text-decoration-line': /^(none|underline|line-through|overline)( (underline|line-through|overline))*$/,
  'list-style-type': /^(none|disc|circle|square|decimal|lower-alpha|upper-alpha|lower-roman|upper-roman)$/,
  'border-collapse': /^(collapse|separate)$/,
}
const edges = ['top', 'right', 'bottom', 'left']
const cssProps = [...colors, ...Object.keys(enums), 'font-size', 'width', 'max-width',
  ...edges.flatMap(side => ['padding-' + side, 'margin-' + side, 'border-' + side + '-style', 'border-' + side + '-width'])]
const color = /^(?:#[a-f\d]{3,8}|[a-z]{1,20}|rgba?\([\d.,%\s/]+\)|hsla?\([\d.,%\s/]+\))$/i
const quoteContainers = '.gmail_quote, .gmail_quote_container, .yahoo_quoted, .protonmail_quote'
const replyHeaders = '.gmail_attr, .moz-cite-prefix, #divRplyFwdMsg'
const compactLabels = new Set('span b strong em i font small td th'.split(' '))
const percentWidthTags = new Set('table col colgroup td th img'.split(' '))
const responsiveElements = new Set('article aside blockquote div figure footer header img main ol p pre section table ul'.split(' '))
// Long identifiers can break without shrinking neighboring headings to a letter.
const longCellToken = /([\x21-\x7e]{48,})/

function historyHint(node: Element, tag: string) {
  if (tag === 'blockquote' && node.getAttribute('type')?.toLowerCase() === 'cite') return 'quote'
  if (tag !== 'div' && tag !== 'p' && tag !== 'section' && tag !== 'blockquote') return null
  if (node.matches(quoteContainers)) return 'quote'
  return node.matches(replyHeaders) ? 'header' : null
}

function hasTableHeadings(table: HTMLTableElement) {
  for (const row of table.tHead?.rows ?? table.rows) {
    if (row.cells.length > 1 && Array.from(row.cells).some(cell => cell.localName === 'th')) return true
  }
  return false
}

function fitWhitespace(node: Element, tag: string, safeCss: string[]) {
  const whiteSpace = safeCss.join(';').split(';').filter(css => css.startsWith('white-space:')).at(-1)
  if (whiteSpace !== 'white-space:nowrap') return
  if (node.closest('pre')) safeCss.push('white-space:pre-wrap')
  else if (!compactLabels.has(tag) || (node.textContent?.trim().length ?? 0) > 48) safeCss.push('white-space:normal')
}

function cssValue(prop: string, value: string) {
  if (colors.has(prop)) return color.test(value)
  if (enums[prop]) return enums[prop].test(value)
  if (prop.endsWith('-style')) return /^(solid|dashed|dotted|double|none)$/.test(value)
  const unit = /^(\d+(?:\.\d+)?)(px|pt|em|rem|%)?$/.exec(value)
  if (!unit) return prop === 'font-size' && /^(small|medium|large|x-small|x-large|xx-large)$/.test(value)
  const amount = Number(unit[1])
  if (!unit[2]) return amount === 0
  const width = prop.endsWith('width') && !prop.startsWith('border')
  if (unit[2] === '%') return amount <= (prop === 'font-size' ? 250 : width ? 100 : 8)
  if (unit[2] === 'em' || unit[2] === 'rem') return amount <= (width ? 80 : 3)
  return amount <= (width ? 1200 : prop.startsWith('border') ? 8 : 72)
}

export function escapeMail(value: string) {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function declarations(style: CSSStyleDeclaration) {
  const css: string[] = []
  for (const prop of cssProps) {
    const value = style.getPropertyValue(prop)
    if (value && cssValue(prop, value)) css.push(prop + ':' + value)
  }
  return css.join(';')
}

// Inspect top-level rules only. Media queries, imports, keyframes, fonts and
// quoted CSS data are never evaluated in an active document.
function* flatRules(source: string) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '')
  let start = 0, open = 0, depth = 0, quote = '', nested = false
  for (let i = 0; i < css.length; i++) {
    const c = css[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === ';' && depth === 0) start = i + 1
    else if (c === '{') {
      if (depth++ === 0) { open = i; nested = false }
      else nested = true
    } else if (c === '}' && depth > 0 && --depth === 0) {
      const selector = css.slice(start, open).trim()
      if (!nested && selector && !selector.startsWith('@')) yield [selector, css.slice(open + 1, i)]
      start = i + 1
    }
  }
}

// Preserve common class-based newsletter formatting. Complex selectors, at-rules
// and resource-bearing properties never enter the document we display.
function stylesheetDeclarations(fragment: DocumentFragment) {
  const rules: { selector: string; css: string; weight: number }[] = []
  const token = /^(?:[a-z][a-z0-9-]*)?(?:[.#][a-z_][a-z0-9_-]*){0,3}$/i
  const parsed = document.createElement('span').style
  let cssBytes = 0
  for (const sheet of fragment.querySelectorAll('style')) {
    const source = sheet.textContent || ''
    cssBytes += source.length
    if (cssBytes > 128_000) break
    for (const [selectors, body] of flatRules(source)) {
      parsed.cssText = body
      const css = declarations(parsed)
      if (!css) continue
      for (const entry of selectors.split(',')) {
        const selector = entry.trim()
        const segments = selector.split(/\s+/)
        if (!selector || selector.length > 120 || segments.length > 3 || !segments.every(piece => token.test(piece))) continue
        const weight = (selector.match(/#/g)?.length ?? 0) * 100 + (selector.match(/\./g)?.length ?? 0) * 10
          + segments.filter(piece => /^[a-z]/i.test(piece)).length
        rules.push({ selector, css, weight })
        if (rules.length === 96) break
      }
      if (rules.length === 96) break
    }
    if (rules.length === 96) break
  }
  const styles = new WeakMap<Element, string>()
  let matches = 0
  for (const rule of rules.sort((a, b) => a.weight - b.weight)) {
    for (const element of fragment.querySelectorAll(rule.selector)) {
      if (++matches > 32_000) return styles
      const prior = styles.get(element) || ''
      if (prior.length + rule.css.length < 2500) styles.set(element, prior + rule.css + ';')
    }
  }
  return styles
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

export function cleanMailHtml(html: string, inlineImages: Record<string, string>, palette?: ReaderPalette) {
  if (!html || html.length > 1024 * 1024) return null
  const template = document.createElement('template')
  template.innerHTML = html
  const classStyles = stylesheetDeclarations(template.content)
  const dark = palette?.scheme === 'dark' ? darkMailColors(palette) : null
  const readerSizeStyle = palette ? document.createElement('div').style : null
  const result: string[] = []
  let count = 0, total = 0, overLimit = false, visible = false
  const add = (fragment: string) => {
    total += fragment.length
    if (total > 8 * 1024 * 1024) overLimit = true
    else result.push(fragment)
  }
  function visit(node: Node, depth: number, context?: ColorContext, inCell = false) {
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
    if (!(node instanceof Element) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') return
    let tag = node.localName
    if (discard.has(tag) || node.hasAttribute('hidden') || (node as HTMLElement).style.display === 'none') return
    if (tag === 'a') tag = 'span'
    // An outer wrapper also contains legacy layout tables made entirely of td
    // cells, so their intrinsic width never shifts unrelated paragraphs.
    const scrollTable = !!palette && node instanceof HTMLTableElement
      && (!node.parentElement?.closest('table') || hasTableHeadings(node))
    if (allowed.has(tag)) {
      const attrs: string[] = []
      const attr = (name: string, value: string) => attrs.push(' ' + name + '="' + escapeMail(value) + '"')
      const history = historyHint(node, tag)
      if (history) attr('data-mail-history', history)
      const style = (node as HTMLElement).style
      const safeCss = [classStyles.get(node), declarations(style)].filter((value): value is string => !!value)
      for (const [key, prop] of [['bgcolor', 'background-color'], ['color', 'color'], ['align', 'text-align'], ['valign', 'vertical-align']]) {
        const value = node.getAttribute(key)
        if (value && cssValue(prop, value)) safeCss.unshift(prop + ':' + value)
      }
      if (dark && context) context = dark.apply(safeCss, context, tag)
      const dir = node.getAttribute('dir')
      if (dir && /^(ltr|rtl|auto)$/.test(dir)) attr('dir', dir)
      let widthAttribute = ''
      for (const key of ['colspan', 'rowspan', 'start', 'width', 'cellpadding', 'cellspacing', 'border', 'size']) {
        const value = node.getAttribute(key)
        if (key === 'width' && value && percentWidthTags.has(tag) && /^\d{1,3}(?:\.\d{1,3})?%$/.test(value)
          && Number(value.slice(0, -1)) <= 100) {
          attr(key, value)
          widthAttribute = value
          continue
        }
        if (value && /^\d{1,4}$/.test(value) && Number(value) <= (key === 'start' ? 9999 : key === 'width' ? 1200 : key === 'size' ? 7 : 32)) {
          attr(key, value)
          if (key === 'width') widthAttribute = value + 'px'
        }
      }
      if (tag === 'col' || tag === 'colgroup') {
        const span = node.getAttribute('span')
        if (span && /^\d{1,2}$/.test(span) && Number(span) >= 1 && Number(span) <= 32) attr('span', span)
      }
      fitWhitespace(node, tag, safeCss)
      if (readerSizeStyle && responsiveElements.has(tag)) {
        readerSizeStyle.cssText = safeCss.join(';')
        if (readerSizeStyle.maxWidth) safeCss.push('max-width:min(100%,' + readerSizeStyle.maxWidth + ')')
        // WebKit can size a table to its authored width despite max-width.
        const width = tag === 'table' && (readerSizeStyle.width || widthAttribute)
        if (width) safeCss.push('width:min(100%,' + width + ')')
      }
      if (safeCss.length) attr('style', safeCss.join(';'))
      if (tag === 'img') {
        const alt = (node.getAttribute('alt') || '').slice(0, 320)
        const src = node.getAttribute('src') || ''
        const cid = /^cid:(.+)$/i.exec(src.trim())?.[1]
        let key = cid
        if (cid) { try { key = decodeURIComponent(cid) } catch { key = undefined } }
        const data = key && Object.prototype.hasOwnProperty.call(inlineImages, key) ? inlineImages[key] : ''
        if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(data)) {
          if (alt.trim()) { add('<span class="image-alt">' + escapeMail(alt) + '</span>'); visible = true }
          return
        }
        attr('src', data)
        attr('alt', alt)
        visible = true
      }
      if (scrollTable) add('<div class="mail-table-scroll">')
      add('<' + tag + attrs.join('') + '>')
      if (voidTags.has(tag)) return
    }
    for (const child of node.childNodes) visit(child, depth + 1, context, inCell || tag === 'td' || tag === 'th')
    if (allowed.has(tag)) add('</' + tag + '>')
    if (scrollTable) add('</div>')
  }
  for (const node of template.content.childNodes) visit(node, 0, dark?.base)
  return overLimit || !visible ? null : result.join('')
}

const policy = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'; connect-src 'none'"
const sheet = `
*{box-sizing:border-box}html,body{margin:0;padding:0}body{color:#27303a;background:white;font:15px/1.65 -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif;overflow-wrap:anywhere}
#mail-content{display:flow-root;padding:3px 1px 8px}#mail-content>:first-child{margin-top:0}#mail-content>:last-child{margin-bottom:0}
p{margin:.6em 0}h1,h2,h3,h4,h5,h6{line-height:1.35;margin:1em 0 .45em}h1{font-size:1.6em}h2{font-size:1.35em}
table{border-collapse:collapse;max-width:100%}
/* Keep whole words in the table's intrinsic column widths. */
td,th{padding:.25em .5em;overflow-wrap:break-word;word-break:normal}
.mail-long-token{overflow-wrap:anywhere;white-space:normal}
table[border]:not([border="0"]) :is(td,th){border:1px solid #a6afbb}
blockquote{margin:.65em 0;padding-inline-start:.8em;border-inline-start:2px solid var(--mail-divider,#a6afbb);color:#485667}
blockquote blockquote{margin-inline:0!important;padding-inline:0!important;border-left:0!important;border-right:0!important}
pre,.plain{white-space:pre-wrap;overflow-wrap:anywhere}pre{font: .92em/1.55 ui-monospace,monospace}
img{max-width:100%;height:auto;vertical-align:middle}.image-alt{color:#66717f;font-size:.94em}
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
.reading .mail-table-scroll{min-width:0;max-width:100%;overflow-x:auto;overscroll-behavior-inline:contain}
.reading .mail-table-scroll:focus-visible{outline:2px solid currentColor;outline-offset:-2px}
.reading #mail-content :where(${[...responsiveElements].join(',')}){max-width:100%}
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
  const bodyClass = palette ? ' class="reading"' : envelope ? ' class="export"' : ''
  return '<!doctype html><html lang="zh-CN"' + readerStyle + '><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + policy + '"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + sheet + (palette ? readingSheet : '') + '</style></head><body' + bodyClass + '>' + envelope + '<div id="mail-content">' + body + '</div></body></html>'
}
