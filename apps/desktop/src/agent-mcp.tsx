import { invoke } from '@tauri-apps/api/core'
import { Copy, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { errorMessage, type MailSummary } from './archive'
import { IconAction } from './controls'
import './agent-mcp.css'

interface Share {
  shareId: string
  subject: string
  sender: string
}

interface AgentSettings {
  enabled: boolean
  command: string
  shares: Share[]
}

export type AgentAction =
  | { kind: 'open_search'; query: string; scope: 'inbox' | 'archive' }
  | { kind: 'open_draft'; id: number }
  | { kind: 'draft_changed' }

export const agentMcp = {
  settings: () => invoke<AgentSettings>('mcp_settings'),
  enable: (enabled: boolean) => invoke<AgentSettings>('mcp_set_enabled', { enabled }),
  share: (id: number) => invoke<AgentSettings>('mcp_share_mail', { id }),
  revoke: (shareId: string) => invoke<AgentSettings>('mcp_revoke_mail', { shareId }),
  takeDraft: (id: number) => invoke<void>('mcp_take_draft', { id }),
}

export function AgentMcpSettings() {
  const [settings, setSettings] = useState<AgentSettings | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const configInput = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let live = true
    agentMcp.settings().then(
      (state) => { if (live) setSettings(state) },
      (issue: unknown) => { if (live) setError(errorMessage(issue)) },
    )
    return () => { live = false }
  }, [])

  async function change(operation: () => Promise<AgentSettings>) {
    setBusy(true)
    setError('')
    setCopied(false)
    try {
      setSettings(await operation())
    } catch (issue) {
      setError(errorMessage(issue))
    } finally {
      setBusy(false)
    }
  }

  const config = settings?.command
    ? JSON.stringify({ mcpServers: { lofold: { command: settings.command, args: ['--mcp'] } } }, null, 2)
    : ''

  return <section className="account-page" aria-label="Agent MCP">
    <div className="account-content settings-content agent-settings">
      <div className="agent-setting-row">
        <div>
          <h2>本机 Agent 连接</h2>
          <p className="muted">允许已配置的本机 MCP 客户端打开查信、编写草稿，以及读取你共享的邮件。</p>
        </div>
        <label className="agent-toggle">
          <input type="checkbox" role="switch" aria-label="启用本机 Agent MCP" checked={settings?.enabled ?? false}
            disabled={!settings || busy} onChange={(event) => {
              const enabled = event.target.checked
              void change(() => agentMcp.enable(enabled))
            }} />
          <span>{settings?.enabled ? '已开启' : '已关闭'}</span>
        </label>
      </div>
      {error && <p className="agent-feedback" role="alert">{error}</p>}
      {config && <div className="agent-connection">
        <div className="agent-heading">
          <label htmlFor="agent-config">MCP 客户端配置</label>
          <IconAction icon={Copy} label="复制 MCP 客户端配置" onClick={() => {
            void Promise.resolve().then(() => navigator.clipboard.writeText(config)).then(
              () => setCopied(true),
              () => { configInput.current?.focus(); configInput.current?.select(); setCopied(false) },
            )
          }} />
        </div>
        <textarea id="agent-config" ref={configInput} readOnly value={config} spellCheck={false} rows={7} />
        {copied && <p role="status">已复制客户端配置。</p>}
      </div>}
      {settings?.enabled && <div className="agent-sharing">
        <h2>已共享邮件</h2>
        {settings.shares.length === 0
          ? <p className="muted">打开一封邮件，从「更多邮件操作」选择共享。</p>
          : <ul className="agent-shares">{settings.shares.map((share) => <li key={share.shareId}>
            <div><strong>{share.subject || '无主题'}</strong><small>{share.sender}</small></div>
            <IconAction icon={Trash2} label={`撤回共享 ${share.subject || '无主题'}`} disabled={busy}
              onClick={() => void change(() => agentMcp.revoke(share.shareId))} />
          </li>)}</ul>}
        <p className="muted">关闭连接时撤回本次会话的所有共享。</p>
      </div>}
    </div>
  </section>
}

export function AgentShareDialog({ mail, close, shared }: {
  mail: MailSummary
  close: () => void
  shared: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const modal = dialog.current
    modal?.showModal()
    return () => modal?.close()
  }, [])

  async function share() {
    setBusy(true)
    setError('')
    try {
      await agentMcp.share(mail.id)
      shared()
    } catch (issue) {
      setError(errorMessage(issue))
    } finally {
      setBusy(false)
    }
  }

  return <dialog className="agent-dialog" ref={dialog} aria-labelledby="agent-share-heading" onCancel={(event) => {
    event.preventDefault()
    if (!busy) close()
  }}>
    <header className="agent-heading">
      <h2 id="agent-share-heading">共享给 Agent MCP</h2>
      <IconAction icon={X} label="关闭共享" disabled={busy} onClick={close} />
    </header>
    <p><strong>{mail.subject || '无主题'}</strong></p>
    <p>已连通的本机客户端可读取这封邮件的主题、发件人和正文。请选择允许共享的邮件。</p>
    {error && <p className="agent-feedback" role="alert">{error}</p>}
    <div className="agent-dialog-actions">
      <button className="secondary" type="button" autoFocus disabled={busy} onClick={close}>取消</button>
      <button className="secondary" type="button" disabled={busy} onClick={() => void share()}>共享此邮件</button>
    </div>
  </dialog>
}
