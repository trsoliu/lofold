import { isMac } from './platform'
import { invoke } from '@tauri-apps/api/core'
import { KeyRound, Mail, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { errorMessage } from './archive'
import { IconAction } from './controls'
import type { AccountChoice, ServerSettings } from './mail-workspace'
import { ServerForm } from './server-settings'

interface Account extends AccountChoice {
  probe: {
    status: 'uncertain' | 'accepted' | 'received' | 'rejected'
    messageId: number | null
  } | null
}

const statusText = {
  uncertain: '发件结果待确认',
  accepted: 'SMTP 已接收，等待查收',
  received: '收发验证通过',
  rejected: 'SMTP 未接受样信',
} as const

const authorizationHelp = (address: string) => address.toLowerCase().endsWith('@gmail.com')
  ? '使用 Google 账号的应用专用密码。'
  : '在网页邮箱开启 IMAP／SMTP，并为 LoFold 生成独立客户端授权码。'

type Props = {
  onViewMessage: (id: number) => void
  onAccounts: (items: AccountChoice[]) => void
  onRemoved: (id: number) => void
}

export function Accounts({ onViewMessage, onAccounts, onRemoved }: Props) {
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<number | null>(null)
  const [configuring, setConfiguring] = useState<number | null>(null)
  const [removing, setRemoving] = useState<Account | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [notice, setNotice] = useState<{ text: string; error?: boolean; accountId?: number } | null>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const serverNotice = notice?.accountId === configuring ? notice : null

  async function refresh() {
    const items = await invoke<Account[]>('list_accounts')
    setAccounts(items)
    onAccounts(items)
  }

  useEffect(() => {
    void refresh().catch((error: unknown) => setNotice({ text: errorMessage(error), error: true }))
  }, [])

  async function perform(operation: () => Promise<string>, accountId?: number) {
    setBusy(true)
    setNotice(null)
    try {
      setNotice({ text: await operation(), accountId })
    } catch (error) {
      setNotice({ text: errorMessage(error), error: true, accountId })
    } finally {
      await refresh().catch((error: unknown) => setNotice({ text: errorMessage(error), error: true }))
      setBusy(false)
    }
  }

  function importMailMaster() {
    void perform(async () => {
      const added = await invoke<number>('import_mailmaster')
      return added ? `已导入 ${added} 个邮箱账号。请逐个授权。` : '没有可新增的受支持账号。'
    })
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const address = new FormData(form).get('address')
    if (typeof address !== 'string') return
    void perform(async () => {
      const added = await invoke<number>('add_mail_account', { address })
      form.reset()
      setShowAdd(false)
      return added ? '邮箱地址已保存。' : '此邮箱已在列表中。'
    })
  }

  function authorize(event: FormEvent<HTMLFormElement>, id: number) {
    event.preventDefault()
    const form = event.currentTarget
    const authorization = new FormData(form).get('authorization')
    form.reset()
    if (typeof authorization !== 'string') return
    void perform(async () => {
      await invoke('authorize_mail_account', { id, authorization })
      setEditing(null)
      return 'IMAP 和 SMTP 授权通过。'
    })
  }

  function saveServers(id: number, servers: ServerSettings, authorization?: string) {
    void perform(async () => {
      const settings = { id, servers }
      await invoke('save_mail_servers', authorization === undefined ? settings : { ...settings, authorization })
      if (authorization === undefined) return '服务器配置已保存。'
      setConfiguring(null)
      return 'IMAP 和 SMTP 授权通过。'
    }, id)
  }

  async function checkProbe(id: number) {
    const message = await invoke<number | null>('check_mail_probe', { id })
    return message === null
      ? '暂未在收件箱找到原样信。稍后点「查收样信」复验。'
      : '收发通过。样信已归档，中文附件字节一致。'
  }

  return (
    <section className="account-page" aria-labelledby="accounts-title">
      <div className="account-content">
        <h1 id="accounts-title">邮箱账号</h1>
        <p className="muted">163、QQ 和 Gmail 可直接授权。企业邮箱或其他服务商可填写自己的收发服务器。</p>
        <div className="account-actions">
          {isMac && <button className="secondary" disabled={busy} onClick={importMailMaster}>从邮箱大师导入</button>}
          <button ref={addButton} className="secondary" disabled={busy} onClick={() => setShowAdd(!showAdd)} aria-expanded={showAdd}>
            手动添加
          </button>
        </div>
        {showAdd && <form className="account-form" onSubmit={add}>
          <label>邮箱地址<input type="email" name="address" autoComplete="email" maxLength={254} required /></label>
          <button className="secondary" disabled={busy}>添加</button>
        </form>}
        {notice && !serverNotice && <p className="account-notice" role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
        {busy && <p className="account-notice" role="status">正在处理，请稍候…</p>}
        {accounts?.length === 0 && <p className="account-empty muted">还没有账号。</p>}
        {accounts && accounts.length > 0 && <ul className="account-list">
          {accounts.map((account) => {
            const probe = account.probe
            const status = probe ? statusText[probe.status]
              : account.connected ? '已授权'
              : account.servers ? '待验证'
              : account.canAuthorize ? '待授权' : '待配置服务器'
            const waiting = probe?.status === 'accepted' || probe?.status === 'uncertain'
            return (
              <li key={account.id} className="account-item">
                <div className="account-summary">
                  <div className="account-identity">
                    <Mail size={17} aria-hidden="true" />
                    <div>
                      <h2>{account.address}</h2>
                      <p className="muted">{status}</p>
                    </div>
                  </div>
                  <div className="account-actions">
                    {(!account.canAuthorize || account.servers) && <button className="secondary"
                      aria-expanded={configuring === account.id} disabled={busy} onClick={() => {
                        setEditing(null)
                        setConfiguring(configuring === account.id ? null : account.id)
                      }}>服务器配置</button>}
                    {account.canAuthorize && !account.servers && (
                      <IconAction icon={KeyRound} label={account.connected ? '重新授权' : '授权'} disabled={busy}
                        aria-expanded={editing === account.id} onClick={() => {
                          setConfiguring(null)
                          setEditing(editing === account.id ? null : account.id)
                        }} />)}
                    {account.connected && (waiting
                      ? <button className="secondary" disabled={busy} onClick={() => void perform(() => checkProbe(account.id))}>查收样信</button>
                      : <button className="secondary" disabled={busy} onClick={() => void perform(async () => {
                        await invoke('send_mail_probe', { id: account.id })
                        return checkProbe(account.id)
                      })}>发送样信给自己</button>
                    )}
                    {probe?.messageId != null && <button className="secondary" onClick={() => onViewMessage(probe.messageId!)}>查看样信</button>}
                    <IconAction icon={Trash2} label={`移除 ${account.address}`} title="移除本机邮箱"
                      disabled={busy} aria-haspopup="dialog" onClick={() => setRemoving(account)} />
                  </div>
                </div>
                {configuring === account.id && <ServerForm address={account.address} saved={account.servers ?? null}
                  busy={busy} notice={serverNotice} save={(servers, authorization) => saveServers(account.id, servers, authorization)}
                  close={() => setConfiguring(null)} />}
                {editing === account.id && <div className="account-auth">
                  <p className="muted">{authorizationHelp(account.address)}</p>
                  <form className="account-form" onSubmit={(event) => authorize(event, account.id)}>
                    <label>授权码<input type="password" name="authorization" autoComplete="off" maxLength={256} required /></label>
                    <button className="secondary" disabled={busy}>验证并保存</button>
                  </form>
                </div>}
              </li>
            )
          })}
        </ul>}
        {accounts === null && !notice && <p className="account-empty muted" role="status">正在读取账号…</p>}
        {accounts === null && notice?.error && <button className="secondary" disabled={busy} onClick={() => void perform(async () => {
          await refresh()
          return '账号已加载。'
        })}>重试</button>}
        {removing && <RemoveAccountDialog account={removing} cancel={() => setRemoving(null)} removed={() => {
          const { id, address } = removing
          setRemoving(null)
          setEditing(null)
          setConfiguring(null)
          setAccounts((items) => items?.filter((account) => account.id !== id) ?? null)
          onRemoved(id)
          setNotice({ text: `已从 LoFold 移除 ${address}。` })
          requestAnimationFrame(() => addButton.current?.focus())
        }} />}
      </div>
    </section>
  )
}

function RemoveAccountDialog({ account, cancel, removed }: {
  account: Account
  cancel: () => void
  removed: () => void
}) {
  const modal = useRef<HTMLDialogElement>(null)
  const [impact, setImpact] = useState<{ drafts: number; savedSearches: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const dialog = modal.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    invoke<{ drafts: number; savedSearches: number }>('preview_account_removal', { id: account.id })
      .then(
        (result) => { if (active) setImpact(result) },
        (issue) => { if (active) setError(errorMessage(issue)) },
      )
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [account.id, attempt])

  async function remove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (removing || !impact) return
    setRemoving(true)
    setError('')
    try {
      await invoke('remove_mail_account', { id: account.id })
      modal.current?.close()
      removed()
    } catch (issue) {
      setError(errorMessage(issue))
      setRemoving(false)
    }
  }

  function close() {
    modal.current?.close()
    cancel()
  }

  return <dialog ref={modal} className="mail-action-dialog account-remove-dialog" aria-labelledby="remove-account-heading"
    onCancel={(event) => { event.preventDefault(); if (!removing) close() }}>
    <form onSubmit={(event) => void remove(event)}>
      <h2 id="remove-account-heading">移除本机邮箱？</h2>
      <p><bdi>{account.address}</bdi></p>
      <p className="muted">此邮箱将停止在 LoFold 收发。此邮箱的本机授权和写作资料（含签名、常用表述）会一并清除。邮箱服务商保留账号和邮件。已下载的邮件和附件可在「本机归档」查阅。</p>
      {loading && <p className="muted" role="status">正在检查本机资料…</p>}
      {!!impact?.drafts && <p>{impact.drafts} 封草稿将留在「所有草稿」，并取消关联的发件邮箱。</p>}
      {!!impact?.savedSearches && <p>将移除这个账号专属的 {impact.savedSearches} 个固定搜索。</p>}
      {error && <p role="alert">{error}</p>}
      <div className="account-actions">
        <button className="secondary" type="button" autoFocus disabled={removing} onClick={close}>取消</button>
        {!loading && !impact
          ? <button className="secondary" type="button" onClick={() => setAttempt(attempt + 1)}>重试</button>
          : <button className="secondary mail-danger" disabled={loading || removing}>
            {removing ? '正在移除…' : '确认移除'}
          </button>}
      </div>
    </form>
  </dialog>
}
