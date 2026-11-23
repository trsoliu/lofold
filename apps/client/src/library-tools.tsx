import { invoke } from '@tauri-apps/api/core'
import { Bookmark, BookmarkMinus, Download, FileText, FolderOpen, RefreshCw, Search } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { archive, errorMessage } from './archive'
import { ControlSelect, IconAction } from './controls'
import type { AccountChoice, Folder } from './mail-workspace'
import { WatermarkReader } from './watermark-tools'

export interface SearchSpec {
  name: string
  folder: Folder
  accountId: number | null
  query: string
  attachmentsOnly: boolean
}

export interface SavedSearch extends SearchSpec { id: number }

interface AttachmentHit {
  messageId: number
  ordinal: number
  filename: string
  subject: string
  sender: string
}

interface AttachmentPage { items: AttachmentHit[]; hasMore: boolean }

interface StorageStatus {
  messages: number
  attachments: number
  rawBytes: number
  storedBlockBytes: number
}

export const folderNames: Record<Folder, string> = {
  archive: '本机归档',
  inbox: '所有收件箱',
  unread: '所有未读',
  sent: '已发送',
  flagged: '红旗邮件',
  junk: '垃圾邮件',
  trash: '已删除',
  remote: '服务器文件夹',
}

function accountName(accounts: AccountChoice[], id: number | null) {
  return id === null ? '所有账号' : accounts.find((account) => account.id === id)?.address ?? '原账号'
}

function AccountScope({ accounts, id, change }: { accounts: AccountChoice[]; id: number | null; change: (id: number | null) => void }) {
  return <ControlSelect className="scope-select" aria-label="选择邮箱范围" value={id ?? ''} onChange={(event) => change(event.target.value ? Number(event.target.value) : null)}>
    <option value="">所有本机邮件</option>
    {accounts.map((account) => <option key={account.id} value={account.id}>{account.address}</option>)}
  </ControlSelect>
}

export function Attachments({ accounts, query, scope, changeQuery, changeScope, openMessage }: {
  accounts: AccountChoice[]
  query: string
  scope: number | null
  changeQuery: (query: string) => void
  changeScope: (scope: number | null) => void
  openMessage: (id: number) => void
}) {
  const [page, setPage] = useState<AttachmentPage | null>(null)
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  const generation = useRef(0)

  useEffect(() => {
    const token = ++generation.current
    setPage(null)
    setNotice(null)
    setBusy(false)
    const timer = window.setTimeout(() => {
      invoke<AttachmentPage>('list_attachments', { query, accountId: scope, offset: 0 }).then(
        (page) => { if (generation.current === token) setPage(page) },
        (error) => { if (generation.current === token) setNotice({ text: errorMessage(error), error: true }) },
      )
    }, query ? 160 : 0)
    return () => { window.clearTimeout(timer); generation.current++ }
  }, [query, scope, retry])

  async function more() {
    const token = generation.current
    if (!page) return
    setBusy(true)
    try {
      const result = await invoke<AttachmentPage>('list_attachments', { query, accountId: scope, offset: page.items.length })
      if (generation.current === token) setPage({ items: [...page.items, ...result.items], hasMore: result.hasMore })
    } catch (error) {
      if (generation.current === token) setNotice({ text: errorMessage(error), error: true })
    } finally {
      if (generation.current === token) setBusy(false)
    }
  }

  async function save(item: AttachmentHit) {
    const token = generation.current
    setBusy(true)
    setNotice(null)
    try {
      if (await archive.save(item.messageId, item.ordinal) && generation.current === token) setNotice({ text: '附件已保存。' })
    } catch (error) {
      if (generation.current === token) setNotice({ text: errorMessage(error), error: true })
    } finally {
      if (generation.current === token) setBusy(false)
    }
  }

  return <section className="account-page" aria-labelledby="attachments-title">
    <div className="account-content">
      <h1 id="attachments-title">附件中心</h1>
      <div className="library-controls">
        <div className="search">
          <Search size={16} aria-hidden="true" />
          <input type="search" value={query} onChange={(event) => changeQuery(event.target.value)} aria-label="搜索附件名" placeholder="搜索附件名" maxLength={160} />
        </div>
        <AccountScope accounts={accounts} id={scope} change={changeScope} />
      </div>
      {notice && <p className="account-notice" role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
      {page === null && !notice && <p className="account-notice muted" role="status">正在读取附件…</p>}
      {page === null && notice?.error && <button className="secondary" onClick={() => setRetry((n) => n + 1)}>重试</button>}
      {page?.items.length === 0 && <p className="account-notice muted">{query ? '没有匹配的本机附件。' : '收取或导入带附件的邮件后，附件会出现在这里。'}</p>}
      {!!page?.items.length && <ul className="account-list">
        {page.items.map((item) => <li className="account-item account-summary" key={item.messageId + '/' + item.ordinal}>
          <div className="account-identity">
            <FileText size={18} aria-hidden="true" /><div><h2>{item.filename}</h2><p className="muted">{item.subject || '无主题'} · {item.sender || '未知发件人'}</p></div>
          </div>
          <div className="account-actions">
            <IconAction icon={FolderOpen} label="定位原信" onClick={() => openMessage(item.messageId)} />
            <IconAction icon={Download} label="保存附件" disabled={busy} onClick={() => void save(item)} />
          </div>
        </li>)}
      </ul>}
      {page?.hasMore && <button className="secondary" disabled={busy} onClick={() => void more()}>加载更多</button>}
    </div>
  </section>
}

export function PinnedSearches({ accounts, open }: { accounts: AccountChoice[]; open: (spec: SearchSpec) => void }) {
  const [items, setItems] = useState<SavedSearch[] | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [deleting, setDeleting] = useState<number | null>(null)

  useEffect(() => {
    let active = true
    setError('')
    invoke<SavedSearch[]>('list_saved_searches').then(
      (items) => { if (active) setItems(items) },
      (error) => { if (active) setError(errorMessage(error)) },
    )
    return () => { active = false }
  }, [retry])

  async function remove(id: number) {
    setDeleting(id)
    setError('')
    try {
      await invoke('unpin_search', { id })
      setItems((items) => items?.filter((item) => item.id !== id) ?? null)
    } catch (issue) {
      setError(errorMessage(issue))
    } finally {
      setDeleting(null)
    }
  }

  return <section className="account-page" aria-labelledby="pinned-title">
    <div className="account-content">
      <h1 id="pinned-title">固定搜索</h1>
      {error && <p className="account-notice" role="alert">{error}</p>}
      {items === null && !error && <p className="account-notice muted" role="status">正在读取固定搜索…</p>}
      {items === null && error && <button className="secondary" onClick={() => setRetry((n) => n + 1)}>重试</button>}
      {items?.length === 0 && <p className="account-notice muted">在邮件列表输入关键词，再点击「固定搜索」。</p>}
      {!!items?.length && <ul className="account-list">
        {items.map((item) => <li className="account-item account-summary" key={item.id}>
          <button className="draft-row pinned-row" onClick={() => open(item)}>
            <Bookmark size={15} aria-hidden="true" /><strong>{item.name}</strong>
            <span className="muted">{[folderNames[item.folder], item.accountId !== null ? accountName(accounts, item.accountId) : '', item.query, item.attachmentsOnly ? '含附件' : ''].filter(Boolean).join(' · ')}</span>
          </button>
          <IconAction icon={BookmarkMinus} label={'取消固定 ' + item.name} disabled={deleting !== null} onClick={() => void remove(item.id)} />
        </li>)}
      </ul>}
    </div>
  </section>
}

export function PinSearch({ spec, close, saved }: { spec: Omit<SearchSpec, 'name'>; close: () => void; saved: () => void }) {
  const modal = useRef<HTMLDialogElement>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const dialog = modal.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = new FormData(event.currentTarget).get('name')
    if (typeof name !== 'string' || !name.trim()) return
    setBusy(true)
    setError('')
    try {
      await invoke('pin_search', { spec: { ...spec, name } })
      saved()
    } catch (issue) {
      setError(errorMessage(issue))
      setBusy(false)
    }
  }

  return <dialog ref={modal} className="library-dialog" aria-labelledby="pin-heading" onCancel={(event) => {
    event.preventDefault()
    if (!busy) close()
  }}>
    <h2 id="pin-heading">固定当前搜索</h2>
    <form className="account-form" onSubmit={(event) => void submit(event)}>
      <label>名称<input name="name" required maxLength={40} autoFocus /></label>
      {error && <p role="alert">{error}</p>}
      <div className="account-actions">
        <button type="button" className="secondary" disabled={busy} onClick={close}>取消</button>
        <button className="secondary" disabled={busy}>保存</button>
      </div>
    </form>
  </dialog>
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KiB'
  return (bytes / 1048576).toFixed(1) + ' MiB'
}

export function OfflineStorage({ accounts, version, syncing, refresh }: {
  accounts: AccountChoice[]
  version: number
  syncing: boolean
  refresh: (id: number | null) => void
}) {
  const [scope, setScope] = useState<number | null>(null)
  const [data, setData] = useState<StorageStatus | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let active = true
    setData(null)
    setError('')
    invoke<StorageStatus>('storage_status', { accountId: scope }).then(
      (status) => { if (active) setData(status) },
      (issue) => { if (active) setError(errorMessage(issue)) },
    )
    return () => { active = false }
  }, [scope, version, retry])

  return <section className="account-page" aria-labelledby="offline-title">
    <div className="account-content">
      <h1 id="offline-title">离线准备</h1>
      <div className="library-controls">
        <AccountScope accounts={accounts} id={scope} change={setScope} />
        <IconAction icon={RefreshCw} label={syncing ? '正在收取' : '备齐最近 20 封'} aria-busy={syncing}
          disabled={syncing || !accounts.some((account) => account.connected && (scope === null || account.id === scope))} onClick={() => refresh(scope)} />
      </div>
      {error && <div className="account-notice"><p role="alert">{error}</p><button className="secondary" onClick={() => setRetry((n) => n + 1)}>重试</button></div>}
      {!data && !error && <p className="account-notice muted" role="status">正在读取本机存储…</p>}
      {data && <>
        <dl className="storage-metrics">
          <div><dt>已缓存邮件</dt><dd>{data.messages} 封</dd></div>
          <div><dt>附件</dt><dd>{data.attachments} 个</dd></div>
          <div><dt>原件字节</dt><dd>{formatBytes(data.rawBytes)}</dd></div>
          <div><dt>存储块载荷</dt><dd>{formatBytes(data.storedBlockBytes)}</dd></div>
        </dl>
        <p className="account-notice muted">已缓存邮件及其附件可以断网查阅。存储块载荷为邮件块的编码大小，数据库文件还包含索引和加密开销。</p>
      </>}
      <WatermarkReader />
    </div>
  </section>
}
