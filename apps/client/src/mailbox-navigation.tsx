import { Archive, AtSign, Ban, Bookmark, ChevronRight, FileText, Flag, FolderClosed, HardDrive, Inbox, MailOpen, Paperclip, Send, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { ControlSelect } from './controls'
import type { AccountChoice, Folder, MailboxChoice } from './mail-workspace'

export type Screen = Exclude<Folder, 'remote'> | `mailbox-${number}` | 'accounts' | 'drafts' | 'attachments' | 'saved' | 'offline' | 'settings' | 'appearance'

const accountFolders = [
  { id: 'inbox', label: '收件箱', icon: Inbox },
  { id: 'unread', label: '未读', icon: MailOpen },
  { id: 'flagged', label: '红旗邮件', icon: Flag },
  { id: 'drafts', label: '草稿箱', icon: FileText },
  { id: 'sent', label: '已发送', icon: Send },
  { id: 'junk', label: '垃圾邮件', icon: Ban },
  { id: 'trash', label: '已删除', icon: Trash2 },
] as const

const unified = [
  { id: 'inbox', label: '所有收件箱', icon: Inbox },
  { id: 'unread', label: '所有未读', icon: MailOpen },
  { id: 'flagged', label: '所有红旗', icon: Flag },
] as const

const workspaceLinks = [
  { id: 'drafts', label: '所有草稿', icon: FileText },
  { id: 'sent', label: '所有已发送', icon: Send },
  { id: 'archive', label: '本机归档', icon: Archive },
  { id: 'attachments', label: '附件中心', icon: Paperclip },
  { id: 'saved', label: '固定搜索', icon: Bookmark },
  { id: 'offline', label: '离线准备', icon: HardDrive },
  { id: 'accounts', label: '邮箱账号', icon: AtSign },
] as const

const globalLinks = [...unified, ...workspaceLinks]
const expandedKey = 'lofold.expandedAccounts'
const orderKey = 'lofold.accountOrder'

type AccountDrag = {
  id: number
  pointerId: number
  startX: number
  startY: number
  x: number
  y: number
  active: boolean
}

export function screenLabel(screen: Screen, scope: number | null) {
  const links = scope === null ? globalLinks : accountFolders
  return links.find((item) => item.id === screen)?.label ?? '本机归档'
}

export function accountStatus(account: AccountChoice) {
  if (account.connected) return null
  if (account.servers) return '待验证'
  return account.canAuthorize === false ? '待配置服务器' : '待授权'
}

type Props = {
  screen: Screen
  scope: number | null
  accounts: AccountChoice[]
  mailboxes: MailboxChoice[]
  navigate: (screen: Screen, account?: number) => void
}

export function MailboxNavigation({ screen, scope, accounts, mailboxes, navigate }: Props) {
  const [expanded, setExpanded] = useState<number[] | null>(() => {
    const stored = localStorage.getItem(expandedKey)
    return stored === null ? null : stored.split(',').filter(Boolean).map(Number)
  })
  const [order, setOrder] = useState(() => (localStorage.getItem(orderKey) ?? '').split(',')
    .map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))
  const [openOther, setOpenOther] = useState<number[]>([])
  const [dragging, setDragging] = useState<number | null>(null)
  const [dropBefore, setDropBefore] = useState<number | null>()
  const [announcement, setAnnouncement] = useState('')
  const navigation = useRef<HTMLElement>(null)
  const accountSection = useRef<HTMLElement>(null)
  const drag = useRef<AccountDrag | null>(null)
  const suppressDragClick = useRef(false)
  const canReorder = accounts.length > 1
  const rank = new Map(order.map((id, index) => [id, index]))
  const ordered = [...accounts].sort((a, b) => (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length))
  const defaultAccount = accounts.find((account) => account.connected)?.id ?? accounts[0]?.id
  const open = expanded ?? (defaultAccount === undefined ? [] : [defaultAccount])

  useEffect(() => {
    if (scope === null) return
    setExpanded((stored) => {
      const current = stored ?? (defaultAccount === undefined ? [] : [defaultAccount])
      return current.includes(scope) ? current : [...current, scope]
    })
  }, [scope, screen, defaultAccount])

  useEffect(() => {
    if (expanded !== null) localStorage.setItem(expandedKey, expanded.join(','))
  }, [expanded])

  useEffect(() => {
    if (scope !== null && screen.startsWith('mailbox-')) {
      setOpenOther((items) => items.includes(scope) ? items : [...items, scope])
    }
  }, [scope, screen])

  useEffect(() => {
    if (dragging === null) return
    let frame: number
    function scrollRail() {
      const rail = navigation.current
      const current = drag.current
      if (!rail || !current) return
      const { left, right, top, bottom } = rail.getBoundingClientRect()
      if (current.x >= left && current.x <= right && current.y >= top && current.y <= bottom) {
        const edge = 28
        const offset = Math.max(0, current.y - (bottom - edge)) - Math.max(0, top + edge - current.y)
        const previous = rail.scrollTop
        if (offset !== 0) rail.scrollTop += Math.sign(offset) * Math.ceil(Math.abs(offset) / 3)
        if (rail.scrollTop !== previous) setDropBefore(dropTarget(current))
      }
      frame = requestAnimationFrame(scrollRail)
    }
    function cancelOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') clearDrag()
    }
    frame = requestAnimationFrame(scrollRail)
    window.addEventListener('keydown', cancelOnEscape)
    window.addEventListener('blur', clearDrag)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', cancelOnEscape)
      window.removeEventListener('blur', clearDrag)
    }
  }, [dragging])

  function moveAccount(id: number, before: number | null) {
    const index = ordered.findIndex((account) => account.id === id)
    if (index < 0 || (ordered[index + 1]?.id ?? null) === before) return
    const ids = ordered.filter((account) => account.id !== id).map((account) => account.id)
    const position = before === null ? ids.length : ids.indexOf(before)
    if (position < 0) return
    ids.splice(position, 0, id)
    localStorage.setItem(orderKey, ids.join(','))
    setOrder(ids)
    setAnnouncement(`${ordered[index].address} 已移到第 ${position + 1} 位。`)
  }

  function dropTarget({ id, x, y }: AccountDrag) {
    const section = accountSection.current
    const rail = navigation.current?.getBoundingClientRect()
    if (!section || !rail) return undefined
    const { top, bottom, left, right } = section.getBoundingClientRect()
    if (x < left || x > right || y < Math.max(top, rail.top) || y > Math.min(bottom, rail.bottom)) return undefined
    for (const row of section.querySelectorAll<HTMLElement>('[data-mailbox-id]')) {
      const candidate = Number(row.dataset.mailboxId)
      if (candidate === id) continue
      const box = row.getBoundingClientRect()
      if (y < box.top + box.height / 2) return candidate
    }
    return null
  }

  function startDrag(event: PointerEvent<HTMLButtonElement>, id: number) {
    if (!canReorder || !event.isPrimary || event.button !== 0 || event.pointerType === 'touch' || drag.current) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = {
      id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY, active: false,
    }
  }

  function updateDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current
    if (!current || event.pointerId !== current.pointerId) return
    if (!current.active && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 5) return
    current.active = true
    suppressDragClick.current = true
    current.x = event.clientX
    current.y = event.clientY
    setDragging(current.id)
    setDropBefore(dropTarget(current))
  }

  function clearDrag() {
    drag.current = null
    setDragging(null)
    setDropBefore(undefined)
  }

  function endDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current
    if (!current || event.pointerId !== current.pointerId) return
    const target = current.active ? dropTarget({ ...current, x: event.clientX, y: event.clientY }) : undefined
    clearDrag()
    if (target !== undefined) moveAccount(current.id, target)
  }

  function ignoreDragClick(event: MouseEvent<HTMLElement>) {
    // Pointer capture can deliver a click to the row after a drop or cancellation.
    if (!suppressDragClick.current || event.detail === 0) return
    suppressDragClick.current = false
    event.preventDefault()
    event.stopPropagation()
  }

  function moveWithKeyboard(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const next = index + (event.key === 'ArrowUp' ? -1 : 1)
    if (next < 0 || next >= ordered.length) return
    const before = event.key === 'ArrowUp' ? ordered[next].id : ordered[next + 1]?.id ?? null
    const button = event.currentTarget
    moveAccount(ordered[index].id, before)
    requestAnimationFrame(() => button.focus())
  }

  const draggedIndex = ordered.findIndex((account) => account.id === dragging)
  const showDrop = draggedIndex >= 0 && dropBefore !== undefined && (ordered[draggedIndex + 1]?.id ?? null) !== dropBefore

  function globalLink({ id, label, icon: Icon }: (typeof globalLinks)[number]) {
    return <button key={id} className="archive-link" aria-current={scope === null && screen === id ? 'page' : undefined} onClick={() => navigate(id)}>
      <Icon size={16} aria-hidden="true" />{label}
    </button>
  }

  function otherFolders(account: number) {
    return mailboxes.filter((folder) => folder.accountId === account &&
      (folder.kind === 'custom' || folder.kind === 'archive' || folder.kind === 'drafts'))
  }

  return <>
    <nav className="archive-navigation" aria-label="邮箱导航" ref={navigation}
      onPointerDownCapture={(event) => {
        if (event.isPrimary && event.button === 0) suppressDragClick.current = false
      }} onClickCapture={ignoreDragClick}>
      <div className="navigation-section">{unified.map(globalLink)}</div>
      {accounts.length > 0 && <section className="navigation-section" aria-labelledby="mailbox-accounts-title" ref={accountSection}>
        <h2 id="mailbox-accounts-title">我的邮箱</h2>
        {ordered.map((account, index) => {
          const isOpen = open.includes(account.id)
          const status = accountStatus(account)
          const foldersId = 'mailbox-folders-' + account.id
          const others = otherFolders(account.id)
          const drop = showDrop && (dropBefore === account.id ? 'before'
            : dropBefore === null && index === ordered.length - 1 ? 'after' : undefined)
          return <div key={account.id} className="mailbox-account" data-mailbox-id={account.id}
            data-dragging={dragging === account.id || undefined} data-drop={drop || undefined}>
            <button type="button" className="archive-link mailbox-account-toggle" title={account.address}
              aria-expanded={isOpen} aria-controls={foldersId} data-current={scope === account.id}
              data-reorderable={canReorder || undefined} aria-keyshortcuts={canReorder ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
              onPointerDown={(event) => startDrag(event, account.id)} onPointerMove={updateDrag}
              onPointerUp={endDrag} onPointerCancel={clearDrag} onLostPointerCapture={clearDrag}
              onKeyDown={(event) => moveWithKeyboard(event, index)}
              onClick={() => setExpanded(isOpen ? open.filter((id) => id !== account.id) : [...open, account.id])}>
              <ChevronRight size={14} aria-hidden="true" />
              <span className="mailbox-account-identity">
                <bdi>{account.address}</bdi>
                {status && <small>{status}</small>}
              </span>
            </button>
            <div id={foldersId} className="mailbox-folders" role="group" aria-label={account.address} hidden={!isOpen}>
              {accountFolders.map(({ id, label, icon: Icon }) => <button key={id} className="archive-link"
                aria-current={scope === account.id && screen === id ? 'page' : undefined}
                onClick={() => navigate(id, account.id)}>
                <Icon size={15} aria-hidden="true" />
                <span>{label}</span>
                {mailboxes.filter((item) => item.accountId === account.id && item.kind === id)
                  .reduce((total, item) => total + item.unread, 0) || null}
              </button>)}
              {others.length > 0 && <details className="other-mailboxes" open={openOther.includes(account.id)} onToggle={(event) => {
                const open = event.currentTarget.open
                setOpenOther((items) => open === items.includes(account.id) ? items
                  : open ? [...items, account.id] : items.filter((id) => id !== account.id))
              }}>
                <summary>其他文件夹</summary>
                {others.map((folder) => <button key={folder.id} className="archive-link" title={folder.label}
                  aria-current={screen === `mailbox-${folder.id}` ? 'page' : undefined}
                  onClick={() => navigate(`mailbox-${folder.id}`, account.id)}>
                  <FolderClosed size={15} aria-hidden="true" />
                  <span>{folder.kind === 'drafts' ? '服务器草稿' : folder.label}</span>
                  {folder.unread || null}
                </button>)}
              </details>}
            </div>
          </div>
        })}
      </section>}
      <div className="navigation-section">{workspaceLinks.map(globalLink)}</div>
    </nav>
    <span className="visually-hidden" role="status">{announcement}</span>
    <ControlSelect className="compact-navigation" aria-label="邮箱导航"
      value={scope === null ? screen : screen + ':' + scope}
      onChange={(event) => {
        const [id, account] = event.target.value.split(':')
        navigate(id as Screen, account === undefined ? undefined : Number(account))
      }}>
      {globalLinks.map(({ id, label }) => <option value={id} key={id}>{label}</option>)}
      <option value="settings" hidden>设置</option>
      <option value="appearance" hidden>外观设置</option>
      {ordered.map((account) => <optgroup label={account.address} key={account.id}>
        {accountFolders.map(({ id, label }) => <option value={id + ':' + account.id} key={id}>{label}</option>)}
        {otherFolders(account.id).map((folder) => <option key={folder.id} value={`mailbox-${folder.id}:${account.id}`}>
          {folder.kind === 'drafts' ? '服务器草稿' : folder.label}
        </option>)}
      </optgroup>)}
    </ControlSelect>
  </>
}
