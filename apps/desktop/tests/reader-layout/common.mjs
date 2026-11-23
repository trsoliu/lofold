import { readFile } from 'node:fs/promises'

const file = (name) => new URL('fixtures/' + name, import.meta.url)
const alertFile = new URL('../../../../packages/mail-store/tests/fixtures/reader-alert.eml', import.meta.url)
const adjacentBreak = /\r?\n\r?\n/
const cid = 'fixture-alert-chart@lofold.test'

function alertParts(eml) {
  // Decode this fixed fixture format. The production archive tests separately
  // exercise MIME parsing, CID resolution, and preservation of the raw EML.
  const parts = eml.split(/^--lofold-reader-alert(?:--)?\s*$/m)
  const html = parts.find(part => /^Content-Type: text\/html/m.test(part))?.split(adjacentBreak).slice(1).join('\n\n').trim()
  const encoded = parts.find(part => /^Content-Type: image\/png/m.test(part))?.split(adjacentBreak).slice(1).join('').replace(/\s/g, '')
  if (!html || !encoded) throw Error('Missing fixture HTML or image')
  return { html, picture: 'data:image/png;base64,' + encoded, size: Buffer.from(encoded, 'base64').length }
}

export async function fixtureScript(name, { theme }) {
  const { html, picture, size } = alertParts(await readFile(alertFile, 'utf8'))
  const classes = ['legacy', 'fields', 'data-table', 'media']
  const body = name === 'alert' ? html : classes.includes(name) ? await readFile(file(name + '.html'), 'utf8') : ['workspace', 'attachments'].includes(name)
    ? '<h1>合成阅读正文</h1>' + '<p>合成阅读段落，用于验证滚动和焦点。</p>'.repeat(110) + '<p>ATTACHMENT-FIXTURE-END</p>'
    : '<script>parent.__mailScriptRan=true</script>'
  const video = name === 'media' ? (await readFile(file('sample.mp4'))).toString('base64') : null
  return '(' + installFixture.toString() + ')(' + JSON.stringify({ name, theme, body, picture, size, video, cid }) + ');'
}

function installFixture({ name, theme, body, picture, size, video, cid }) {
  localStorage.setItem('lofold.theme', theme)
  const accounts = [1, 2].map(id => ({
    id, address: 'synthetic-reader-' + id + '@example.test', connected: true, canAuthorize: true,
  }))
  const mailboxes = accounts.map(account => ({
    id: account.id * 10, accountId: account.id, label: 'INBOX', kind: 'inbox', loaded: true,
    unread: 4, hasMore: false,
  }))
  const messages = Array.from({ length: name === 'workspace' ? 40 : 2 }, (_, i) => {
    const account = accounts[i % accounts.length]
    const id = i + 1
    return {
      id, accountId: account.id, accountAddress: account.address,
      subject: i === 0 ? '合成阅读测试' : '备用样本 ' + id, sender: 'alerts@example.test',
      recipients: 'reader@example.test', preview: '合成通知，显示当前阅读区域。',
      sentAt: 1769006700, unread: name === 'workspace' && i < 17, flagged: false, pinned: false,
      hasAttachments: i === 0 && ['alert', 'workspace', 'attachments', 'fallback'].includes(name),
      location: { folderId: account.id * 10, uidValidity: 1, uid: id },
    }
  })
  const calls = []
  window.readerTest = { calls }
  window.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
    calls.push({ command, args })
    switch (command) {
      case 'mark_inbox_read': {
        const message = messages.find(m => m.id === args.id && m.accountId === args.account)
        if (message?.unread) {
          message.unread = false
          mailboxes.find(folder => folder.id === message.location.folderId).unread--
        }
        return null
      }
      case 'change_mailbox_message': throw Error('模拟服务器暂未确认。')
      case 'list_attachments': return { items: [{
        messageId: 1, ordinal: 0, filename: '很长的合成附件名称'.repeat(12) + '.pdf',
        subject: '一份较长的合成附件主题，用来检查文件名和操作按钮布局。'.repeat(4), sender: 'alerts@example.test',
      }], hasMore: false }
      case 'message_image_accounts': return { linked: true, accounts: [accounts[0]] }
      case 'list_accounts': return accounts
      case 'list_mailboxes':
      case 'refresh_mailboxes': return mailboxes
      case 'list_mail': return {
        items: messages.filter(m => (args.account == null || args.account === m.accountId)
          && (!args.query || m.subject.includes(args.query))), hasMore: false,
      }
      case 'read_mail': {
        const mail = messages.find(m => m.id === args.id)
        if (!mail) throw Error('Unknown synthetic message')
        const attachments = mail.hasAttachments ? [{
          index: 0, name: name === 'alert' ? 'fixture-alert-chart.png' : '很长的合成附件名称'.repeat(12) + '.pdf', size,
        }] : []
        return {
          ...mail, body: '可见的合成纯文字回退。', bodyTruncated: name === 'fallback', attachments,
          richBody: {
            html: mail.id === 1 || name === 'workspace' ? body : '<p>备用正文</p>',
            inlineImages: { [cid]: picture },
            ...(video && mail.id === 1 ? {
              inlineVideos: { 'sample-video@lofold.test': { ordinal: 0, mime: 'video/mp4' } },
            } : {}),
          },
        }
      }
      case 'load_mail_image': {
        if (args.url.endsWith('/retry.png') && calls.filter(item => item.command === command && item.args.url === args.url).length === 1) {
          return 'data:image/png;base64,AA=='
        }
        if (args.url === 'https://pictures.example.test/retry.png' || args.url === 'https://pictures.example.test/ok.png') return picture
        throw Error('Unexpected media request')
      }
      case 'load_inline_mail_video': {
        if (args.id !== 1 || args.ordinal !== 0 || !video) throw Error('Unexpected video request')
        return Uint8Array.from(atob(video), char => char.charCodeAt(0)).buffer
      }
      case 'save_mail':
      case 'save_message_image':
      case 'print_message': return true
      case 'sync_mailbox': return { stored: 0, considered: 0, skipped: 0 }
      default: return null
    }
  } }
}

export function scenarioScript(name, options) {
  return '(' + runScenario.toString() + ')(' + JSON.stringify({ name, ...options }) + ')'
}

async function runScenario({ name, width, height, theme, captureExports }) {
  const checks = []
  const measurements = { width, height, theme }
  const exports = {}
  const assert = (name, result) => checks.push({ name, ok: Boolean(result) })
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))
  async function available(probe, description) {
    const deadline = performance.now() + 5000
    while (performance.now() < deadline) {
      const value = probe()
      if (value) return value
      await wait(30)
    }
    throw Error('Timeout: ' + description)
  }
  const q = (selector) => document.querySelector(selector)
  const frame = () => q('.rich-mail-frame')
  const body = () => frame()?.contentDocument?.getElementById('mail-content')
  const visible = (element) => Boolean(element?.getClientRects().length)
  const button = (name) => [...document.querySelectorAll('button')].find(el =>
    visible(el) && (el.getAttribute('aria-label') ?? [...el.childNodes]
      .filter(child => child.nodeType === Node.TEXT_NODE || child.getAttribute?.('aria-hidden') !== 'true')
      .map(child => child.textContent).join('').trim()) === name)
  const calls = (name) => window.readerTest.calls.filter(item => item.command === name)
  const fits = element => Boolean(element) && element.scrollWidth <= element.clientWidth + 1
  const rect = (element) => element?.getBoundingClientRect()
  const center = (bounds) => (bounds.top + bounds.bottom) / 2
  const text = (element) => element?.textContent?.trim() ?? ''

  function lineStarts(element) {
    if (!element) return []
    const range = element.ownerDocument.createRange()
    range.selectNodeContents(element)
    const tops = []
    for (const bounds of range.getClientRects()) {
      if (bounds.width > 0 && !tops.some(top => Math.abs(top - bounds.top) < 2)) tops.push(bounds.top)
    }
    return tops
  }
  const lines = (element) => lineStarts(element).length

  function imageFit(image) {
    if (!image?.naturalWidth || !image.naturalHeight) return false
    const box = rect(image)
    return box.width > 0 && box.width <= body().clientWidth + 1
      && Math.abs(box.height - box.width * image.naturalHeight / image.naturalWidth) < 2
  }

  async function attachmentFooter(content, marker) {
    const preview = frame()
    const footer = q('.message > .attachments')
    const last = [...content.querySelectorAll('p')].find(paragraph => text(paragraph) === marker)
    await available(() => preview.clientHeight >= content.scrollHeight - 1, 'complete body height')
    assert('attachment cards follow the last paragraph and the body frame',
      footer && last && (preview.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING)
      && rect(footer).top >= rect(preview).bottom - 1
      && rect(footer).top >= rect(preview).top + rect(last).bottom - 1)
    return footer
  }

  if (name === 'attachments') {
    const nav = await available(() => button('附件中心') ?? q('select[aria-label="邮箱导航"]'), 'attachments navigation')
    if (nav instanceof HTMLSelectElement) {
      nav.value = 'attachments'
      nav.dispatchEvent(new Event('change', { bubbles: true }))
    } else {
      nav.click()
    }
    const open = await available(() => button('定位原信'), 'attachment source')
    const download = await available(() => button('保存附件'), 'attachment download')
    const row = open.closest('li')
    const title = row.querySelector('h2')
    assert('long attachment name truncates on one line', lines(title) === 1 && title.scrollWidth > title.clientWidth
      && getComputedStyle(title).textOverflow === 'ellipsis')
    assert('attachment actions stay beside filename on one row',
      download.closest('li') === row && Math.abs(center(rect(open)) - center(rect(download))) <= 1
      && Math.abs(center(rect(open)) - center(rect(row))) <= 2 && rect(open).left >= rect(title).right - 1
      && rect(download).right <= rect(row).right + 1)
    download.click()
    await available(() => calls('save_mail').length > 0, 'attachment download request')
    assert('download requests the selected attachment ordinal',
      calls('save_mail').at(-1).args.id === 1 && calls('save_mail').at(-1).args.attachmentIndex === 0)
    open.click()
    const sourceBody = await available(body, 'attachment source reader')
    assert('attachment source opens the corresponding message', calls('read_mail').at(-1).args.id === 1)
    const footer = await attachmentFooter(sourceBody, 'ATTACHMENT-FIXTURE-END')
    if (footer) {
      const reader = q('.reader-content')
      const save = footer.querySelector('button')
      assert('long mail begins with the attachment footer below the viewport', rect(footer).top > rect(reader).bottom)
      reader.scrollTop = reader.scrollHeight
      assert('scrolling the reader reaches the attachment download', reader.scrollTop > 0
        && rect(save).top >= rect(reader).top && rect(save).bottom <= rect(reader).bottom + 1)
      save.focus({ preventScroll: true })
      assert('footer attachment download can receive keyboard focus', document.activeElement === save)
      const previous = calls('save_mail').length
      save.click()
      await available(() => calls('save_mail').length > previous, 'reader attachment download')
      assert('footer download requests the source attachment ordinal',
        calls('save_mail').at(-1).args.id === 1 && calls('save_mail').at(-1).args.attachmentIndex === 0)
    }
    assert('document has no horizontal overflow', fits(document.documentElement))
    return { checks, measurements, exports }
  }

  let first = await available(() => q('.mail-row'), 'first mail')
  let previousScroll = 0
  if (name === 'workspace' && width <= 760) {
    const search = q('input[aria-label="搜索邮件"]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, '备用样本')
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await available(() => !text(q('.mail-row')).includes('合成阅读测试') && document.querySelectorAll('.mail-row').length > 24, 'filtered list')
    first = document.querySelectorAll('.mail-row')[15]
    first.scrollIntoView({ block: 'center' })
    previousScroll = q('.mail-list').scrollTop
    assert('filtered list was scrolled before opening a message', previousScroll > 0)
  }
  first.click()
  if (name === 'fallback') {
    const plain = await available(() => q('.message-body'), 'plain fallback')
    assert('unrenderable HTML falls back to readable text', text(plain).includes('可见的合成纯文字回退'))
    const footer = q('.message > .attachments')
    assert('attachment cards also follow plain-text content',
      footer && (plain.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING)
      && rect(footer).top >= rect(plain).bottom - 1)
    assert('preview limit is explicit', document.body.textContent.includes('可导出 EML 查阅全文'))
    assert('filtered content never runs', !window.__mailScriptRan)
    return { checks, measurements, exports }
  }

  const content = await available(body, 'isolated email body')
  measurements.readerWidth = content.clientWidth
  assert('document has no horizontal overflow', fits(document.documentElement))
  assert('message has no horizontal overflow', fits(content))
  assert('message iframe stays script-disabled', frame().getAttribute('sandbox') === 'allow-same-origin')
  assert('nothing loads remote images on open', calls('load_mail_image').length === 0)
  assert('mail HTML cannot run code', !window.__mailScriptRan && !content.querySelector('script, iframe, form, svg, object'))

  if (name === 'alert') {
    const labels = ['级别：', '首次触发：', '最近触发：', '持续时间：', '目标地址：', '触发条件：', '当前值：']
    const values = ['提醒', '2026-01-21 08:35:00', '2026-01-21 14:45:00', '6 h 10 min', '192.0.2.12',
      'avg(rate) >= 87.5%; current=91.4%. 长值仍应完整换行。 fixture-long-diagnostic-token-0123456789012345678901234567890123456789', '91.4%']
    measurements.labels = labels.map((label, index) => {
      const cell = [...content.querySelectorAll('td, th, dt')].find(el => text(el) === label)
      const value = cell?.nextElementSibling
      const labelBounds = rect(cell), valueBounds = rect(value)
      return { label, lines: lines(cell), width: labelBounds?.width ?? 0, value: text(value),
        leadLinesAlign: Math.abs(lineStarts(cell)[0] - lineStarts(value)[0]) <= 3,
        sharesRow: Boolean(labelBounds && valueBounds && labelBounds.right <= valueBounds.left + 1 && Math.abs(labelBounds.top - valueBounds.top) <= 5),
        intact: text(value) === values[index] }
    })
    for (const row of measurements.labels) {
      assert('single-line field label ' + row.label, row.lines === 1)
      assert('complete value in associated row for ' + row.label, row.intact && row.sharesRow && row.leadLinesAlign)
    }
    const chart = await available(() => {
      const image = content.querySelector('img[alt="合成趋势图"]')
      return image?.naturalWidth && image
    }, 'embedded CID chart')
    assert('inline chart renders at the authored aspect without overspill', imageFit(chart))
    assert('final paragraph is retained', text(content).endsWith('ALERT-FIXTURE-END'))
    await attachmentFooter(content, 'ALERT-FIXTURE-END')
  }

  if (name === 'data-table') {
    const table = content.querySelector('thead')?.closest('table')
    const tableWidth = rect(table)?.width
    const wide = table?.closest('.mail-table-scroll')
    assert('data table preserves header and cell spans', table?.querySelector('th[colspan="2"]')
      && table?.querySelector('th[rowspan="2"]') && table.querySelectorAll('thead th').length === 10)
    const layout = table?.parentElement?.closest('table[role="presentation"]')
    assert('the outer presentation table fits the document while preserving the inner scroller',
      wide && layout?.contains(wide) && fits(layout) && rect(layout).width <= content.clientWidth + 1)
    if (content.clientWidth < 980) {
      await available(() => wide?.tabIndex === 0, 'keyboard target for wide table')
      wide.focus()
      assert('wide table scroller can receive keyboard focus', wide.ownerDocument.activeElement === wide)
      wide.scrollLeft = wide.scrollWidth
      assert('wide table overflow is local and scroll reaches far column', wide.scrollWidth > wide.clientWidth
        && wide.scrollLeft > 0 && wide.scrollLeft + wide.clientWidth >= wide.scrollWidth - 1
        && rect([...table.querySelectorAll('td')].find(el => text(el) === 'RIGHTMOST-SENTINEL'))?.right <= rect(wide).right + 3)
    }
    const headerless = [...content.querySelectorAll('td')].find(cell => text(cell) === '无表头数据 A1')?.closest('table')
    assert('independent rows remain unchanged in the headerless matrix', headerless?.rows.length === 3)
    const caption = [...content.querySelectorAll('caption')].find(el => text(el) === '状态巡检分类')
    const rowHeaderTable = caption?.closest('table')
    const firstColumn = rowHeaderTable?.querySelector('col')
    const firstCell = rowHeaderTable?.querySelector('th[scope="row"]')
    assert('captioned two-column data table retains its column and row-header semantics',
      firstColumn && rowHeaderTable.querySelectorAll('th[scope="row"]').length === 2
      && !rowHeaderTable.classList.contains('mail-field-table') && rect(firstCell)?.width >= 225)
    measurements.tableWidth = tableWidth
  }

  if (name === 'fields') {
    const groups = [
      ['th[scope=row]', ['事件类别：', '最后巡检：']],
      ['dt', ['部署环境：', '校验结果：']],
      ['div > span:first-child', ['任务状态：', '后续计划：']],
    ]
    for (const [selector, labels] of groups) {
      for (const label of labels) {
        const term = [...content.querySelectorAll(selector)].find(el => text(el) === label)
        const value = term?.nextElementSibling
        assert(label + ' same-line label and value', lines(term) === 1 && Boolean(value?.textContent.trim())
          && rect(term).right <= rect(value).left + 1 && Math.abs(rect(term).top - rect(value).top) <= 5)
      }
    }
    assert('title and notes spanning both columns remain visible',
      text(content.querySelector('th[colspan="2"]')) === '合成状态摘要'
      && text(content.querySelector('td[colspan="2"]')) === '完整的合成附注。')
  }

  if (name === 'legacy') {
    assert('legacy width-zero wrapper still displays the complete heading', lines(content.querySelector('h1')) === 1)
    assert('oversized flow blocks fit within the reading column',
      rect(content.querySelector('center'))?.width <= content.clientWidth + 1
      && rect(content.querySelector('h2'))?.width <= content.clientWidth + 1)
    assert('long link wraps within the message', text(content).includes('https://example.test/fixture/Averylongtoken') && fits(content))
    assert('code retains original newlines and indentation', content.querySelector('pre')?.textContent.includes('正常:\n  不换缩进\n  continue_with_'))
    const history = [...content.querySelectorAll('details.mail-history')]
    assert('separate quoted messages start collapsed', history.length >= 2 && history.every(quote => !quote.open))
    history.forEach(quote => { quote.open = true })
    const order = text(content)
    assert('replies retain visible chronological order after opening', order.indexOf('LEGACY-CURRENT-END') < order.indexOf('合成引用一')
      && order.indexOf('合成引用一') < order.indexOf('合成引用二') && order.indexOf('合成引用二') < order.indexOf('合成引用一尾段'))
  }

  if (name === 'media') {
    assert('explicit external consent is available', button('加载本封图片'))
    assert('video initially does not load', calls('load_inline_mail_video').length === 0 && !content.querySelector('video'))
    button('加载本封图片')?.click()
    const retry = await available(() => button('重试图片'), 'failed image and retry state')
    assert('successful image kept while broken image is still visibly failed', content.querySelector('img[alt="正常图"]')?.hasAttribute('src')
      && !content.querySelector('img[alt="重试图"]')?.hasAttribute('src'))
    retry.click()
    const retriedImage = await available(() => {
      const image = content.querySelector('img[alt="重试图"]')
      return image?.naturalWidth && image
    }, 'retried image')
    const urls = calls('load_mail_image').map(item => item.args.url)
    assert('retry loads only the failed image', urls.length === 3
      && urls.filter(url => url === 'https://pictures.example.test/ok.png').length === 1
      && urls.filter(url => url === 'https://pictures.example.test/retry.png').length === 2)
    assert('downloaded image maintains ratio', imageFit(retriedImage))
    const videoButton = [...document.querySelectorAll('button')].find(el => visible(el) && text(el).startsWith('打开内嵌视频'))
    assert('local video opens only from explicit reader action', videoButton)
    videoButton?.click()
    const video = await available(() => content.querySelector('video'), 'local video')
    await available(() => video.videoWidth > 0 && video.readyState > 0, 'decoded local video')
    assert('video decodes in reader, has controls and does not autoplay', video.paused && video.controls && !video.autoplay && video.videoWidth === 320
      && rect(video).width <= content.clientWidth + 1 && calls('load_inline_mail_video').length === 1)
    video.muted = true
    const started = await Promise.race([
      video.play().then(() => true, () => false),
      wait(3000).then(() => false),
    ])
    const progressed = started && await available(() => video.currentTime > 0.05 || video.ended, 'local MP4 playback progress')
    assert('local MP4 plays after explicit playback', progressed)
    video.pause()
  }

  if (name === 'workspace') {
    const reader = q('.reader')
    const list = q('.mailbox, .mail-list')
    const nav = q('.archive-navigation')
    const search = q('input[aria-label="搜索邮件"]')
    assert('pane visibility respects compact, split, and desktop boundaries',
      visible(reader) && visible(list) === (width > 760) && visible(nav) === (width >= 966))
    const actions = q('.reader-actions')
    const stamp = q('.message-time-row dd')
    assert('toolbar lives with the time, without the extra reader strip', actions?.closest('.message-time-row') && !q('.reader-toolbar'))
    if (width >= 420) assert('full visible timestamp and same-line tools', fits(stamp) && rect(stamp).right <= rect(actions).left + 1
      && Math.abs(center(rect(stamp)) - center(rect(actions))) <= 2)
    if (width <= 760) assert('touch targets remain at least 40px', [button('返回列表'), ...actions.querySelectorAll('button')]
      .every(el => (rect(el)?.width ?? 0) >= 40 && (rect(el)?.height ?? 0) >= 40))
    button('更多邮件操作')?.click()
    const popup = await available(() => q('.message-action-popover'), 'reader menu')
    assert('more menu fits the reader', rect(popup).right <= width + 1 && rect(popup).left >= 0 && rect(popup).bottom <= height + 1)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await available(() => !q('.message-action-popover'), 'more menu dismissal')
    assert('closing menu restores trigger focus', document.activeElement === button('更多邮件操作'))
    if (width <= 760) button('返回列表')?.click()
    await available(() => visible(search), 'list search')
    const readerScroll = q('.reader-content')
    const listScroll = q('.mail-list')
    if (width > 760) {
      listScroll.scrollTop = 150
      const initial = listScroll.scrollTop
      readerScroll.scrollTop = 600
      assert('reader and list scroll independently', readerScroll.scrollTop > 0 && listScroll.scrollTop === initial)
    } else {
      const selected = await available(() => q('.mail-row[aria-current="true"]'), 'selected row after return')
      assert('return restores filter, selection and prior list scroll',
        search.value === '备用样本' && selected === first && Math.abs(listScroll.scrollTop - previousScroll) <= 2)
      assert('return restores selected row focus', await available(() =>
        document.activeElement === selected, 'return focus'))
    }
    const readNotice = '本机已读。服务器未确认'
    await available(() => document.body.textContent.includes(readNotice), 'read notice')
    assert('opened row clears unread locally despite failed server confirmation',
      first.getAttribute('data-unread') == null && calls('mark_inbox_read').length === 1
      && calls('change_mailbox_message').at(-1)?.args.action === 'syncRead')
  }

  if (captureExports) {
    async function clickMenuAction(label) {
      const trigger = await available(() => {
        const target = button('更多邮件操作')
        return target && !target.disabled && target.getAttribute('aria-expanded') === 'false' && target
      }, 'ready actions menu')
      trigger.click()
      const action = await available(() => button(label), label)
      action.click()
    }
    await clickMenuAction('导出 EML 原件')
    await available(() => calls('save_mail').length > 0, 'original EML export')
    assert('original EML export requests source mail', calls('save_mail').at(-1).args.id === 1 && calls('save_mail').at(-1).args.attachmentIndex == null)
    if (button('更多邮件操作') && /Mac/.test(navigator.platform)) {
      await clickMenuAction('保存邮件长图')
      exports.image = (await available(() => calls('save_message_image').at(-1), 'image rendering')).args.html
      await clickMenuAction('打印…')
      exports.print = (await available(() => calls('print_message').at(-1), 'print rendering')).args.html
      exports.endMarker = name === 'alert' ? 'ALERT-FIXTURE-END' : 'DATA-FIXTURE-END'
      assert('native output contains the complete tail in both modes', exports.image.includes(exports.endMarker) && exports.print.includes(exports.endMarker))
      assert('print and image share the sanitized document', exports.image === exports.print)
    }
  }
  return { checks, measurements, exports }
}
