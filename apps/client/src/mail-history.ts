// HTML passed here has already been serialized by the mail sanitizer. Only
// trusted source classifications and standalone conventional separators split it.
const dashed = /^[-‐‑‒–—－]{2,}\s*(?:original message|forwarded message|原始邮件|原始郵件|转发邮件|轉寄郵件|轉發郵件)\s*[-‐‑‒–—－]{2,}$/i
const forwarded = /^(?:begin forwarded message|开始转发的邮件|開始轉寄的郵件|以下为转发邮件)\s*[:：]$/i
const senderLine = /^(?:from|发件人|寄件者|寄件人|發件人)\s*[:：]\s*(.+)/i
const fieldLine = /^(?:from|sent|date|to|cc|subject|发件人|收件人|抄送|主题|发送时间|日期|寄件者|寄件人|發件人|主旨|時間)\s*[:：]/i
const inline = new Set('a b bdi bdo big cite code del em font i ins kbd mark q s samp small span strike strong sub sup tt u'.split(' '))

function isSeparator(text: string) {
  return text.length <= 160 && (dashed.test(text.trim()) || forwarded.test(text.trim()))
}

function isStandalone(node: Node, side: 'previousSibling' | 'nextSibling') {
  for (let current: Node | null = node; current; current = current.parentNode) {
    for (let sibling = current[side]; sibling; sibling = sibling[side]) {
      if (sibling.nodeType === Node.TEXT_NODE && !sibling.textContent?.trim()) continue
      return sibling instanceof Element && !inline.has(sibling.localName)
    }
    if (!(current.parentElement && inline.has(current.parentElement.localName))) break
  }
  return true
}

// Read a bounded set of leading lines without treating an entire descendant
// newsletter, table or blockquote as a single delimiter.
function leadingLines(node: Element) {
  let text = '', visited = 0
  function collect(child: Node) {
    if (++visited > 80 || text.length > 800) return
    if (child.nodeType === Node.TEXT_NODE) { text += child.textContent?.slice(0, 800) || ''; return }
    if (!(child instanceof Element)) return
    const block = !inline.has(child.localName)
    if (block) text += '\n'
    if (child.localName === 'img') text += '■'
    for (const next of child.childNodes) {
      if (visited > 80 || text.length > 800) break
      collect(next)
    }
    if (block) text += '\n'
  }
  collect(node)
  return text.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 8)
}

function headerSender(node: Element, quote = false) {
  const lines = leadingLines(node)
  if (quote) {
    // A quotation can contain arbitrary content and further messages.
    // Use only the sender immediately after its own explicit separator.
    return isSeparator(lines[0] || '') ? senderLine.exec(lines[1] || '')?.[1].slice(0, 72) || '' : ''
  }
  return lines.map(line => senderLine.exec(line)?.[1]).find(Boolean)?.slice(0, 72) || ''
}

interface Group {
  kind: 'quote' | 'header'
  previous: Group | null
  hasBody: boolean
  sender: string
  number: number
}

interface Run {
  group: Group | null
  visible: boolean
  target: HTMLElement
  parents: Element[]
  clones: Element[]
}

function panel(doc: Document, index: number, collapsed: boolean, open: boolean, sender: string, continuation = false) {
  const container = doc.createElement(collapsed ? 'details' : 'section')
  container.className = 'mail-history'
  if (collapsed && open) container.setAttribute('open', '')
  const label = doc.createElement(collapsed ? 'summary' : 'h3')
  label.className = 'mail-history-summary'
  label.textContent = '历史邮件 ' + index + (continuation ? '（续）' : '') + (sender ? ' · ' + sender : '')
  const content = doc.createElement('div')
  content.className = 'mail-history-content'
  container.append(label, content)
  return { container, content }
}

function visible(node: Node) {
  if (node.nodeType === Node.TEXT_NODE) return !!node.textContent?.trim()
  return node instanceof Element && (node.localName === 'img' || !!node.textContent?.trim() || !!node.querySelector('img'))
}

export function formatMailHistory(html: string, collapsed: boolean): string {
  if (!/(?:data-mail-history|original message|forwarded message|原始邮|原始郵|转发|轉發|轉寄)/i.test(html) || html.length > 8 * 1024 * 1024) return html
  const template = document.createElement('template')
  template.innerHTML = html
  const doc = template.content.ownerDocument
  const output = doc.createElement('div')
  const runs: Run[] = []
  const path: Element[] = []
  let mainVisible = false, visited = 0, count = 0, exceeded = false
  function history(kind: Group['kind'], active: Group | null): Group {
    if (active && !active.hasBody) return active
    if (++count > 96) exceeded = true
    return { kind, previous: active, hasBody: false, sender: '', number: 0 }
  }
  function append(node: Node, active: Group | null, header: boolean) {
    let target = runs[runs.length - 1]
    if (!target || target.group !== active) {
      target = { group: active, visible: false, target: doc.createElement('div'), parents: [], clones: [] }
      runs.push(target)
      output.append(target.target)
      if (runs.length > 512) exceeded = true
    }
    let shared = 0
    while (shared < path.length && target.parents[shared] === path[shared]) shared++
    target.parents.length = target.clones.length = shared
    let parent = target.clones[shared - 1] ?? target.target
    for (let i = shared; i < path.length; i++) {
      const clone = path[i].cloneNode(false) as Element
      clone.removeAttribute('data-mail-history')
      parent.append(clone)
      target.parents.push(path[i])
      target.clones.push(clone)
      parent = clone
    }
    parent.append(node.cloneNode(true))
    if (!visible(node)) return
    target.visible = true
    if (!active) { mainVisible = true; return }
    const text = node.textContent?.trim() || ''
    if (header || (!active.hasBody && fieldLine.test(text))) {
      if (!active.sender) active.sender = senderLine.exec(text)?.[1]?.split(/\n|\s+(?:sent|to|date|subject|发送时间|收件人|主题)\s*[:：]/i)[0].slice(0, 72) || ''
    } else active.hasBody = true
  }
  function walk(node: Node, active: Group | null, insideHeader: boolean): Group | null {
    if (++visited > 40_000 || path.length > 96 || exceeded) { exceeded = true; return active }
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || ''
      const marker = !insideHeader && isSeparator(text) && isStandalone(node, 'previousSibling') && isStandalone(node, 'nextSibling')
      if (marker) active = history('header', active)
      append(node, active, insideHeader || marker)
      return active
    }
    if (!(node instanceof Element)) return active
    let role = node.getAttribute('data-mail-history')
    if (!role && node.localName === 'blockquote' && !insideHeader) {
      const lines = leadingLines(node)
      if (lines.length > 1 && isSeparator(lines[0]) && fieldLine.test(lines[1])) role = 'quote'
    }
    if (role === 'quote' && !insideHeader) {
      const section = history('quote', active)
      if (!section.sender) section.sender = headerSender(node, true)
      let inner: Group | null = section
      for (const child of node.childNodes) inner = walk(child, inner, false)
      // A provider attribution immediately followed by its quote belongs to
      // that quote. Text after the closed wrapper belongs to the outer author.
      return active?.kind === 'header' && active === section ? active.previous : active
    }
    const header = insideHeader || role === 'header'
    if (role === 'header' && !insideHeader) {
      active = history('header', active)
      if (!active.sender) active.sender = headerSender(node)
    }
    // Keep separator-like examples in code and ordinary literary quotations.
    // Known mail containers inside a layout table remain eligible for splitting.
    if (!node.childNodes.length || (['pre', 'code', 'blockquote', 'table'].includes(node.localName)
      && !node.querySelector('[data-mail-history]') && !role)) {
      append(node, active, header)
      return active
    }
    path.push(node)
    for (const child of node.childNodes) active = walk(child, active, header)
    path.pop()
    return active
  }
  let active: Group | null = null
  for (const child of template.content.childNodes) active = walk(child, active, false)
  if (exceeded || !runs.some(run => run.group && run.visible)) return html
  let index = 0
  for (const { target, group, visible } of runs) {
    if (!group || !visible) {
      while (target.firstChild) target.before(target.firstChild)
      target.remove()
      continue
    }
    const continuation = !!group.number
    if (!continuation) group.number = ++index
    const rendered = panel(doc, group.number, collapsed, !mainVisible && index === 1 && !continuation, group.sender, continuation)
    while (target.firstChild) rendered.content.append(target.firstChild)
    target.replaceWith(rendered.container)
  }
  return output.innerHTML
}

export function formatPlainHistory(text: string, collapsed: boolean): string | null {
  if (text.length > 1024 * 1024 || !/(?:original message|forwarded message|原始邮|原始郵|转发|轉發|轉寄)/i.test(text)) return null
  type Message = { depth: number; index: number; sender: string; seen: boolean }
  type Part = { message: Message | null; lines: string[] }
  const parts: Part[] = [], stack: Message[] = []
  let count = 0, mainVisible = false
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const prefix = /^(?:[ \t]*>[ \t]?)+/.exec(raw)?.[0] || ''
    const depth = prefix.split('>').length - 1
    const content = raw.slice(prefix.length).trim()
    if (content) {
      while (stack.length && stack[stack.length - 1].depth > depth) stack.pop()
    }
    if (isSeparator(content)) {
      while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop()
      if (++count > 96) return null
      stack.push({ depth, index: count, sender: '', seen: false })
    }
    const message = stack[stack.length - 1] ?? null
    let part = parts[parts.length - 1]
    if (!part || part.message !== message) {
      part = { message, lines: [] }
      parts.push(part)
    }
    if (!message && content) mainVisible = true
    if (message && !message.sender && part.lines.length < 8) message.sender = senderLine.exec(content)?.[1]?.slice(0, 72) || ''
    part.lines.push(raw + (i + 1 < lines.length ? '\n' : ''))
  }
  if (!count) return null
  const output = document.createElement('div')
  for (const { message, lines } of parts) {
    const block = document.createElement('div')
    block.className = 'plain'
    block.textContent = lines.join('')
    if (!message || !block.textContent.trim()) { output.append(block); continue }
    const rendered = panel(document, message.index, collapsed, !mainVisible && message.index === 1 && !message.seen, message.sender, message.seen)
    message.seen = true
    rendered.content.append(block)
    output.append(rendered.container)
  }
  return output.innerHTML
}
