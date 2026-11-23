import { useEffect, useState } from 'react'
import { errorMessage } from './archive'
import { mailWorkspace, type AccountChoice, type Draft, type MailboxChoice } from './mail-workspace'

type Props = {
  scope: number | null
  title: string
  version: number
  accounts: AccountChoice[]
  edit: (id: number) => void
  serverDrafts: MailboxChoice[]
  openServerDrafts: (folder: MailboxChoice) => void
}

export function Drafts({ scope, title, version, accounts, edit, serverDrafts, openServerDrafts }: Props) {
  const [items, setItems] = useState<Draft[] | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let active = true
    setError('')
    mailWorkspace.drafts(scope).then(
      (items) => { if (active) setItems(items) },
      (issue) => { if (active) setError(errorMessage(issue)) },
    )
    return () => { active = false }
  }, [scope, version, retry])

  const address = accounts.find((account) => account.id === scope)?.address

  return (
    <section className="account-page" aria-labelledby="drafts-title">
      <div className="account-content">
        <h1 id="drafts-title">{title}</h1>
        {address && <p className="drafts-account muted"><bdi>{address}</bdi></p>}
        {serverDrafts.length > 0 && <div className="account-actions">
          {serverDrafts.map((box) => <button key={box.id} className="secondary" onClick={() => openServerDrafts(box)}>
            {scope === null ? `${accounts.find((account) => account.id === box.accountId)?.address ?? box.label} · ` : ''}服务器草稿
          </button>)}
        </div>}
        {error && <div className="account-notice"><p role="alert">{error}</p><button className="secondary" onClick={() => setRetry(retry + 1)}>重试</button></div>}
        {!error && items === null && <p className="account-empty muted" role="status">正在读取草稿…</p>}
        {items?.length === 0 && <p className="account-empty muted">还没有本机草稿。</p>}
        {!!items?.length && <ul className="account-list">
          {items.map((draft) => <li key={draft.id} className="account-item">
            <button className="draft-row" onClick={() => edit(draft.id)}>
              <strong>{draft.fields.subject || '无主题'}</strong>
              {scope === null && <span className="muted">{accounts.find((account) => account.id === draft.fields.accountId)?.address || '未选发件邮箱'}</span>}
              {draft.status !== 'editing' && <span>{draft.status === 'uncertain' ? '发送结果待确认' : '发送失败，可编辑后再提交'}</span>}
            </button>
          </li>)}
        </ul>}
      </div>
    </section>
  )
}
